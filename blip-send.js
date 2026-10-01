// A small window that takes files, dropped, pasted or picked, and sends them
// to one Blip device.
//
// Runs as a separate process (`gjs -m blip-send.js '<json>'`): GNOME Shell only
// accepts drags that start inside the shell, so files dragged from the file
// manager need a real window to land on.
//
// Input: {peer, name}
//   peer  Blip's id for the device, `<user id>:<device id>`
//   name  what to call the device in the window

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');
Gio._promisify(Gdk.Clipboard.prototype, 'read_value_async', 'read_value_finish');
Gio._promisify(Gdk.Clipboard.prototype, 'read_texture_async', 'read_texture_finish');
Gio._promisify(Gdk.Clipboard.prototype, 'read_text_async', 'read_text_finish');

const {peer, name} = JSON.parse(ARGV[0]);
const SEND_TIMEOUT = 20;
const CLOSE_DELAY = 1200;
const HINT = 'Drop files or folders here, or paste with Ctrl+V';
const HINT_DELAY = 2500;
const PASTE_KEEP_SECONDS = 24 * 60 * 60;

// Pasted text and images become files here. Blip reads a file when the other
// device connects, which can be a moment after sending, so they are kept for a
// day instead of being deleted right away.
const PASTE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'island', 'blip']);

function blipBinary() {
    const home = GLib.get_home_dir();
    return GLib.find_program_in_path('blip') ?? [
        `${home}/.local/bin/blip`,
        `${home}/.local/opt/blip/bin/blip`,
    ].find(path => GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE)) ?? null;
}

function removeTree(file) {
    if (file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) === Gio.FileType.DIRECTORY) {
        const children = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        for (const info of children)
            removeTree(file.get_child(info.get_name()));
    }
    file.delete(null);
}

function removeOldPastes() {
    try {
        const base = Gio.File.new_for_path(PASTE_DIR);
        const now = GLib.get_real_time() / 1e6;
        for (const info of base.enumerate_children('standard::name,time::modified', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)) {
            if (now - info.get_attribute_uint64('time::modified') > PASTE_KEEP_SECONDS)
                removeTree(base.get_child(info.get_name()));
        }
    } catch {
        // Nothing pasted yet, or already gone.
    }
}

// A fresh folder per paste keeps the file's name clean ("Pasted text.txt")
// however many are pasted.
function newPasteFile(name) {
    const dir = GLib.build_filenamev([PASTE_DIR, GLib.uuid_string_random()]);
    GLib.mkdir_with_parents(dir, 0o700);
    return Gio.File.new_for_path(GLib.build_filenamev([dir, name]));
}

// What is on the clipboard as files to send: copied files, a copied image, or
// copied text, in that order. Empty when there is none of those.
async function readClipboard(clipboard) {
    const formats = clipboard.get_formats();

    if (formats.contain_gtype(Gdk.FileList.$gtype)) {
        const list = await clipboard.read_value_async(Gdk.FileList.$gtype, GLib.PRIORITY_DEFAULT, null);
        return list.get_files();
    }

    if (formats.contain_gtype(Gdk.Texture.$gtype)) {
        const texture = await clipboard.read_texture_async(null);
        const file = newPasteFile('Pasted image.png');
        texture.save_to_png(file.get_path());
        return [file];
    }

    if (formats.contain_gtype(GObject.TYPE_STRING)) {
        const text = await clipboard.read_text_async(null);
        if (!text)
            return [];
        const file = newPasteFile('Pasted text.txt');
        file.replace_contents(new TextEncoder().encode(text), null, false, Gio.FileCreateFlags.PRIVATE, null);
        return [file];
    }

    return [];
}

// Blip's command line takes one file or folder per call and hands it to the
// running app, so each goes out as its own transfer.
async function send(binary, files) {
    for (const file of files) {
        const path = file.get_path();
        if (!path)
            continue;

        const process = Gio.Subprocess.new(
            [binary, `--peer=${peer}`, `--file=${path}`],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
        const timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SEND_TIMEOUT, () => {
            process.force_exit();
            return GLib.SOURCE_REMOVE;
        });
        try {
            const [output] = await process.communicate_utf8_async(null, null);
            // Blip reports a refused request as "Error: …" and nothing else
            // says whether it took the file, so that line is the failure.
            const error = output?.match(/^Error: (.*)$/m)?.[1];
            if (error)
                throw new Error(error);
        } finally {
            GLib.Source.remove(timeout);
        }
    }
}

const app = new Adw.Application({
    application_id: 'net.k44z.island.BlipSend',
    flags: Gio.ApplicationFlags.NON_UNIQUE,
});

app.connect('activate', () => {
    const page = new Adw.StatusPage({
        icon_name: 'document-send-symbolic',
        title: `Send to ${name}`,
        description: HINT,
        vexpand: true,
    });
    const choose = new Gtk.Button({
        label: 'Choose files…',
        halign: Gtk.Align.CENTER,
        css_classes: ['suggested-action', 'pill'],
    });
    page.set_child(choose);

    const toolbar = new Adw.ToolbarView({content: page});
    toolbar.add_top_bar(new Adw.HeaderBar());
    const window = new Adw.ApplicationWindow({
        application: app,
        title: 'Send with Blip',
        default_width: 380,
        default_height: 340,
        content: toolbar,
    });

    let sending = false;
    const flash = message => {
        page.description = message;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, HINT_DELAY, () => {
            if (!sending)
                page.description = HINT;
            return GLib.SOURCE_REMOVE;
        });
    };
    const sendFiles = async files => {
        if (sending || files.length === 0)
            return;
        sending = true;
        choose.sensitive = false;
        page.title = 'Sending…';
        page.description = files.length === 1 ? files[0].get_basename() : `${files.length} items`;

        const binary = blipBinary();
        try {
            if (!binary)
                throw new Error('Blip is not installed');
            await send(binary, files);
        } catch (e) {
            page.icon_name = 'dialog-error-symbolic';
            page.title = 'Could not send';
            page.description = e.message;
            sending = false;
            choose.sensitive = true;
            return;
        }
        page.icon_name = 'object-select-symbolic';
        page.title = `Sent to ${name}`;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLOSE_DELAY, () => {
            window.close();
            return GLib.SOURCE_REMOVE;
        });
    };

    const paste = async () => {
        if (sending)
            return;
        try {
            const files = await readClipboard(window.get_clipboard());
            if (files.length === 0)
                flash('Nothing to paste: copy a file, an image or some text first');
            else
                sendFiles(files);
        } catch (e) {
            flash(`Could not paste: ${e.message}`);
        }
    };
    const shortcuts = new Gtk.ShortcutController({scope: Gtk.ShortcutScope.GLOBAL});
    shortcuts.add_shortcut(new Gtk.Shortcut({
        trigger: Gtk.ShortcutTrigger.parse_string('<Control>v'),
        action: Gtk.CallbackAction.new(() => {
            paste();
            return true;
        }),
    }));
    window.add_controller(shortcuts);

    const drop = Gtk.DropTarget.new(Gdk.FileList, Gdk.DragAction.COPY);
    drop.connect('drop', (_target, value) => {
        sendFiles(value.get_files());
        return true;
    });
    page.add_controller(drop);

    choose.connect('clicked', () => {
        new Gtk.FileDialog({title: 'Choose files to send'}).open_multiple(window, null, (dialog, result) => {
            try {
                const model = dialog.open_multiple_finish(result);
                sendFiles(Array.from({length: model.get_n_items()}, (_, i) => model.get_item(i)));
            } catch {
                // Cancelled.
            }
        });
    });

    window.present();
    removeOldPastes();
});

app.run([]);
