// Blip support: announces incoming and outgoing transfers and keeps the list
// of devices files can be sent to.
//
// Blip sends no desktop notifications and has no API, so this follows the
// journal, where the desktop app logs its events, and raises notifications
// itself. Sending runs through Blip's command line (see blip-send.js).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {parseBlipLine} from './blip-parse.js';

const JOURNAL_IDENTIFIER = 'net.blip.Blip.desktop';
const ICON_NAME = 'net.blip.Blip';
const STALL_TIMEOUT = 30;

function homeRelative(path) {
    const home = GLib.get_home_dir();
    return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function openUri(uri) {
    Gio.AppInfo.launch_default_for_uri_async(uri, global.create_app_launch_context(0, -1), null,
        (_source, result) => {
            try {
                Gio.AppInfo.launch_default_for_uri_finish(result);
            } catch (e) {
                console.warn(`Island: could not open ${uri}: ${e.message}`);
            }
        });
}

// Selects the file in the file manager, or opens its folder if that fails.
function showInFolder(path) {
    const file = Gio.File.new_for_path(path);
    Gio.DBus.session.call(
        'org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
        'org.freedesktop.FileManager1', 'ShowItems',
        new GLib.Variant('(ass)', [[file.get_uri()], '']),
        null, Gio.DBusCallFlags.NONE, -1, null,
        (connection, result) => {
            try {
                connection.call_finish(result);
            } catch {
                openUri(file.get_parent().get_uri());
            }
        });
}

// Blip names this machine after its hardware model, so that name tells it
// apart from the user's other devices.
function ownDeviceName() {
    try {
        const [, bytes] = GLib.file_get_contents('/sys/devices/virtual/dmi/id/product_name');
        return new TextDecoder().decode(bytes).trim();
    } catch {
        return '';
    }
}

/**
 * Opens the small window that takes files and sends them to `device`.
 *
 * @param {string} extensionPath folder holding blip-send.js
 * @param {{userId: string, id: string, name: string}} device
 */
export function openSender(extensionPath, device) {
    try {
        Gio.Subprocess.new(
            ['gjs', '-m', `${extensionPath}/blip-send.js`,
                JSON.stringify({peer: `${device.userId}:${device.id}`, name: device.name})],
            Gio.SubprocessFlags.NONE);
    } catch (e) {
        console.warn(`Island: could not open the Blip sender: ${e.message}`);
    }
}

export const BlipWatcher = GObject.registerClass({
    Signals: {'devices-changed': {}},
}, class BlipWatcher extends GObject.Object {
    constructor(settings) {
        super();
        this._settings = settings;
        this._ownName = ownDeviceName();
        this._devices = [];
        this._transfers = new Map();
        this._pending = new Map();
        this._source = null;
        this._cancellable = null;
        this._process = null;
    }

    /** Other devices that can receive files, online ones first. */
    get devices() {
        return this._devices;
    }

    get enabled() {
        return this._settings.get_boolean('show-blip-transfers');
    }

    start() {
        this._settings.connectObject('changed::show-blip-transfers', () => this._sync(), this);
        this._sync();
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._unfollow();
    }

    _sync() {
        if (this.enabled)
            this._follow();
        else
            this._unfollow();
    }

    _follow() {
        if (this._process)
            return;
        try {
            this._process = Gio.Subprocess.new(
                ['journalctl', '--user', '--follow', '--lines=0', '--output=cat',
                    `--identifier=${JOURNAL_IDENTIFIER}`],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.warn(`Island: could not follow the Blip log: ${e.message}`);
            return;
        }
        const stream = new Gio.DataInputStream({
            base_stream: this._process.get_stdout_pipe(),
            close_base_stream: true,
        });
        this._cancellable = new Gio.Cancellable();
        this._readLines(stream, this._cancellable);
        this._loadDevices(this._cancellable);
    }

    _unfollow() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._process?.force_exit();
        this._process = null;
        for (const transfer of this._transfers.values())
            this._clearStall(transfer);
        this._transfers.clear();
        this._pending.clear();
        this._source?.destroy();
        this._source = null;
        this._setUsers([]);
    }

    async _readLines(stream, cancellable) {
        try {
            for (;;) {
                const [line] = await stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable);
                if (line === null || cancellable.is_cancelled())
                    break;
                this._handle(parseBlipLine(new TextDecoder().decode(line)));
            }
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`Island: Blip log stopped: ${e.message}`);
        }
    }

    // Blip repeats the device list every few minutes; this fetches the latest
    // one so the list is there before the next repeat.
    async _loadDevices(cancellable) {
        try {
            const process = Gio.Subprocess.new(
                ['journalctl', '--user', '--output=cat', `--identifier=${JOURNAL_IDENTIFIER}`,
                    '--grep=UsersDiscovered', '--since=-1d', '--lines=1'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            const [stdout] = await process.communicate_utf8_async(null, cancellable);
            const event = parseBlipLine(stdout?.trim() ?? '');
            if (event?.kind === 'devices' && !cancellable.is_cancelled() && this._devices.length === 0)
                this._setUsers(event.users);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`Island: could not read the Blip devices: ${e.message}`);
        }
    }

    _setUsers(users) {
        const devices = users.flatMap(user => user.devices
            .filter(device => !(user.isSelf && device.kind === 'Laptop' && device.name === this._ownName))
            .map(device => ({...device, userId: user.id, userName: user.name})))
            .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));

        if (JSON.stringify(devices) === JSON.stringify(this._devices))
            return;
        this._devices = devices;
        this.emit('devices-changed');
    }

    _handle(event) {
        if (!event)
            return;

        if (event.kind === 'devices') {
            this._setUsers(event.users);
            return;
        }

        const transfer = this._transfers.get(event.id);
        switch (event.kind) {
        case 'create':
            this._pending.set(event.id, event.peer);
            break;
        case 'preflight':
            this._begin(event, 'in');
            break;
        case 'content':
            // The files of a transfer started from this machine.
            if (this._pending.has(event.id))
                this._begin(event, 'out');
            break;
        case 'progress':
            if (transfer && !transfer.done)
                this._progress(transfer, event);
            break;
        case 'complete':
            if (transfer)
                this._finished(transfer);
            break;
        case 'dismiss':
            // Dismissed in Blip before it finished: nothing left to follow.
            if (transfer && !transfer.done)
                transfer.notification.destroy();
            if (transfer)
                this._forget(transfer);
            this._pending.delete(event.id);
            break;
        }
    }

    _begin({id, items, locations}, direction) {
        // The app logs the same events whichever way a file goes, but only
        // incoming ones unpack to disk.
        if (items.length === 0 || (direction === 'in' && locations.size === 0))
            return;

        const paths = items.map(item => locations.get(item.name)).filter(Boolean);
        if (direction === 'in' && paths.length === 0)
            return;

        const peer = this._pending.get(id);
        const transfer = {
            id,
            direction,
            peer: peer ? (this._devices.find(d => d.id === peer.deviceId)?.name ?? '') : '',
            items,
            paths,
            bytes: items.reduce((sum, item) => sum + item.size, 0),
            percent: 0,
            kbps: null,
            done: false,
            interrupted: false,
            stall: 0,
            notification: this._createNotification(),
        };
        this._transfers.set(id, transfer);

        this._armStall(transfer);
        this._fill(transfer, 'active');
        this._notify(transfer.notification);
    }

    _progress(transfer, {bytes, kbps}) {
        this._armStall(transfer);
        transfer.percent = transfer.bytes > 0 ? Math.min(99, Math.floor(bytes / transfer.bytes * 100)) : 0;
        transfer.kbps = kbps;

        // Changing the text of a card that is showing updates it in place;
        // only coming back from an interruption needs to pop it up again.
        const resumed = transfer.interrupted;
        transfer.interrupted = false;
        this._fill(transfer, 'active');
        if (resumed)
            this._notify(transfer.notification);
    }

    _finished(transfer) {
        this._clearStall(transfer);
        transfer.done = true;
        transfer.interrupted = false;
        const {notification, items, paths, direction} = transfer;
        this._fill(transfer, 'done');

        notification.clearActions();
        if (direction === 'in') {
            if (items.length === 1 && !items[0].dir)
                notification.addAction(_('Open'), () => openUri(Gio.File.new_for_path(paths[0]).get_uri()));
            notification.addAction(_('Show in folder'), () => showInFolder(paths[0]));
        }
        this._notify(notification);
    }

    // Blip logs nothing when a transfer is cancelled or the other side goes
    // away, so a transfer that stops reporting is taken to be interrupted.
    _interrupted(transfer) {
        transfer.interrupted = true;
        this._fill(transfer, 'interrupted');
        this._notify(transfer.notification);
    }

    _armStall(transfer) {
        this._clearStall(transfer);
        transfer.stall = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, STALL_TIMEOUT, () => {
            transfer.stall = 0;
            this._interrupted(transfer);
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearStall(transfer) {
        if (!transfer.stall)
            return;
        GLib.Source.remove(transfer.stall);
        transfer.stall = 0;
    }

    _forget(transfer) {
        this._clearStall(transfer);
        this._transfers.delete(transfer.id);
    }

    _fill(transfer, state) {
        const {items, paths, bytes, percent, kbps, direction, peer, notification} = transfer;
        const incoming = direction === 'in';
        const name = items.length === 1
            ? items[0].name
            : ngettext('%s and %d more', '%s and %d more', items.length - 1)
                .format(items[0].name, items.length - 1);

        let title;
        let detail;
        switch (state) {
        case 'done':
            title = incoming
                ? ngettext('File received', 'Files received', items.length)
                : ngettext('File sent', 'Files sent', items.length);
            detail = incoming
                ? homeRelative(GLib.path_get_dirname(paths[0]))
                : (peer ? _('to %s').format(peer) : '');
            break;
        case 'interrupted':
            title = _('Transfer interrupted');
            detail = '';
            break;
        default:
            title = incoming
                ? ngettext('Receiving file', 'Receiving files', items.length)
                : ngettext('Sending file', 'Sending files', items.length);
            detail = [
                percent > 0 ? `${percent}%` : (bytes > 0 ? GLib.format_size(bytes) : ''),
                kbps ? `${GLib.format_size(Math.round(kbps * 125))}/s` : '',
                !incoming && peer ? _('to %s').format(peer) : '',
            ].filter(Boolean).join(' · ');
        }

        notification.title = title;
        notification.body = detail ? `${name} · ${detail}` : name;
    }

    _createNotification() {
        if (!this._source) {
            this._source = new MessageTray.Source({title: 'Blip', 'icon-name': ICON_NAME});
            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }
        const notification = new MessageTray.Notification({source: this._source});
        // Opening the card of a received file shows it in its folder.
        notification.connect('activated', () => {
            const transfer = [...this._transfers.values()].find(t => t.notification === notification);
            if (transfer?.done && transfer.direction === 'in')
                showInFolder(transfer.paths[0]);
        });
        return notification;
    }

    _notify(notification) {
        this._source?.addNotification(notification);
    }
});
