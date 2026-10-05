// Unread mail count from Thunderbird's own folder cache.
//
// Thunderbird keeps the unread count of every folder in folderCache.json in
// its profile and rewrites it as mail comes in, so reading it needs no
// network access or login. The count is whatever Thunderbird last knew: it
// goes stale while Thunderbird is closed.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');

export const APP_IDS = [
    'net.thunderbird.Thunderbird.desktop',
    'org.mozilla.Thunderbird.desktop',
    'thunderbird.desktop',
];

const ROOTS = [
    '.thunderbird',
    '.var/app/net.thunderbird.Thunderbird/.thunderbird',
    'snap/thunderbird/common/.thunderbird',
];

// nsMsgFolderFlags.Inbox
const INBOX_FLAG = 0x1000;

function profilePath(root) {
    const keyFile = new GLib.KeyFile();
    try {
        keyFile.load_from_file(GLib.build_filenamev([root, 'profiles.ini']), GLib.KeyFileFlags.NONE);
    } catch {
        return null;
    }

    // The profile the installed Thunderbird uses, then the one flagged default.
    const groups = keyFile.get_groups()[0];
    const profileGroups = groups.filter(g => g.startsWith('Profile'));
    let path = null;
    let relative = true;
    const install = groups.find(g => g.startsWith('Install'));
    if (install) {
        path = keyFile.get_string(install, 'Default');
    } else {
        const group = profileGroups.find(g => {
            try {
                return keyFile.get_string(g, 'Default') === '1';
            } catch {
                return false;
            }
        });
        if (group) {
            path = keyFile.get_string(group, 'Path');
            try {
                relative = keyFile.get_string(group, 'IsRelative') !== '0';
            } catch {}
        }
    }
    if (!path)
        return null;

    // Install sections hold a relative path, or an absolute one.
    return GLib.path_is_absolute(path) || !relative
        ? path
        : GLib.build_filenamev([root, path]);
}

export function findFolderCache() {
    for (const root of ROOTS) {
        const profile = profilePath(GLib.build_filenamev([GLib.get_home_dir(), root]));
        if (!profile)
            continue;
        const file = Gio.File.new_for_path(GLib.build_filenamev([profile, 'folderCache.json']));
        if (file.query_exists(null))
            return file;
    }
    return null;
}

// Total unread messages in the inboxes of all accounts, or null if
// Thunderbird's data can't be read.
export async function readUnread() {
    const file = findFolderCache();
    if (!file)
        return null;
    try {
        const [bytes] = await file.load_contents_async(null);
        const folders = JSON.parse(new TextDecoder().decode(bytes));
        let unread = 0;
        for (const folder of Object.values(folders)) {
            if (folder.flags & INBOX_FLAG)
                unread += Math.max(0, folder.totalUnreadMsgs ?? 0);
        }
        return unread;
    } catch {
        return null;
    }
}
