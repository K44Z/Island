// Turns one line of Blip's log into a small event object.
//
// Blip has no API and sends no desktop notifications, but the desktop app
// logs every internal event to stdout, which the journal picks up:
//
//   level=INFO msg="reducing event" tag=DesktopApp type=*event.TransferComplete event=&{TransferId:abc}
//
// The part after `event=` is Go's debug print of the event, wrapped in Go
// quotes when it contains spaces. Only the few events below matter.

const STRING = '"((?:[^"\\\\]|\\\\.)*)"';
const ITEM_RE = new RegExp(`items:\\{key:${STRING} value:\\{(\\w+):\\{(?:size:(\\d+))?`, 'g');
const LOCATION_RE = new RegExp(`disk_locations:\\{key:${STRING} value:${STRING}\\}`, 'g');
const DEVICE_RE = new RegExp(
    `devices:\\{key:${STRING} value:\\{device_id:${STRING}(?: kind:(\\w+))?(?: name:${STRING})? reach:\\{([^}]*)\\}`, 'g');

const TRANSFER_EVENTS = {
    TransferPreflightComplete: 'preflight',
    TransferContentJobSucceeded: 'content',
    TransferCreateRequested: 'create',
    TransferProgress: 'progress',
    TransferComplete: 'complete',
    TransferDismiss: 'dismiss',
    TransferRemoveRequested: 'dismiss',
};

function unquote(raw) {
    if (!raw.startsWith('"'))
        return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return raw.slice(1, -1).replace(/\\(.)/g, '$1');
    }
}

function unescape(text) {
    return text.replace(/\\(.)/g, (_match, c) => c === 'n' ? '\n' : c === 't' ? '\t' : c);
}

function parseItems(payload) {
    const items = [...payload.matchAll(ITEM_RE)].map(([, name, type, size]) => ({
        name: unescape(name),
        size: Number(size ?? 0),
        dir: type !== 'file',
    }));
    const locations = new Map([...payload.matchAll(LOCATION_RE)]
        .map(([, name, path]) => [unescape(name), unescape(path)]));
    return {items, locations};
}

// Users arrive as `user_id:"…" email:"…" name:"…" devices:{…} devices:{…}
// is_self:true`, one after another. Emails are deliberately never read.
function parseUsers(payload) {
    return payload.split(/\buser_id:(?=")/).slice(1).map(chunk => {
        const id = chunk.match(new RegExp(`^${STRING}`))?.[1];
        const firstDevice = chunk.indexOf('devices:{');
        const head = firstDevice < 0 ? chunk : chunk.slice(0, firstDevice);
        const name = head.match(new RegExp(`\\bname:${STRING}`))?.[1];
        const devices = [...chunk.matchAll(DEVICE_RE)].map(([, , deviceId, kind, deviceName, reach]) => ({
            id: unescape(deviceId),
            kind: kind ?? 'Unknown',
            name: unescape(deviceName ?? '').trim(),
            online: /\bis_online:true\b/.test(reach),
        }));
        return {
            id: id ? unescape(id) : '',
            name: unescape(name ?? '').trim(),
            isSelf: /\bis_self:true\b/.test(chunk),
            devices,
        };
    }).filter(user => user.id);
}

/**
 * @param {string} line one journal line
 * @returns {?object} null for anything uninteresting, otherwise one of
 *   {kind: 'devices', users: {id, name, isSelf, devices: {id, kind, name, online}[]}[]}
 *   {kind: 'preflight' | 'content', id, items: {name, size, dir}[], locations: Map<name, path>}
 *       an incoming transfer about to unpack / an outgoing one's files
 *   {kind: 'create', id, peer: {userId, deviceId}}   a transfer started here
 *   {kind: 'progress', id, bytes, kbps}    bytes so far; speed in kilobits/s once measured
 *   {kind: 'complete' | 'dismiss', id}
 */
export function parseBlipLine(line) {
    const head = line.match(/\btype=\*event\.(\w+) event=(.*)$/);
    if (!head)
        return null;

    const [, type, raw] = head;
    if (type === 'UsersDiscovered')
        return {kind: 'devices', users: parseUsers(unquote(raw))};

    const kind = TRANSFER_EVENTS[type];
    if (!kind)
        return null;

    const payload = unquote(raw);
    const id = payload.match(/(?:TransferId|transfer_id):"?([0-9a-fA-F-]+)/)?.[1];
    if (!id)
        return null;

    switch (kind) {
    case 'preflight':
    case 'content':
        return {kind, id, ...parseItems(payload)};
    case 'create': {
        const userId = payload.match(/\buser_id:"([^"\\]+)"/)?.[1];
        const deviceId = payload.match(/\bdevice_id:"([^"\\]+)"/)?.[1];
        return userId && deviceId ? {kind, id, peer: {userId, deviceId}} : null;
    }
    case 'progress': {
        const kbps = payload.match(/\bkbps:([\d.]+)/)?.[1];
        return {
            kind,
            id,
            bytes: Number(payload.match(/\bProgress:(\d+)/)?.[1] ?? 0),
            kbps: kbps ? Number(kbps) : null,
        };
    }
    default:
        return {kind, id};
    }
}
