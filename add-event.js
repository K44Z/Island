// Creates one event in the default calendar of Evolution Data Server.
//
// Runs as a separate process (`gjs -m add-event.js '<json>'`) so the shell
// never loads the Evolution libraries itself. On success it prints the new
// event's UID on stdout; on failure it prints the reason on stderr and nothing
// on stdout.
//
// Input: {summary, allDay, start, end}
//   timed:   start / end are unix seconds
//   all day: start / end are 'YYYYMMDD', end is exclusive

import ECal from 'gi://ECal?version=2.0';
import EDataServer from 'gi://EDataServer?version=1.2';
import GLib from 'gi://GLib';
import ICalGLib from 'gi://ICalGLib?version=3.0';
import System from 'system';

const CONNECT_TIMEOUT = 20;

function escapeText(text) {
    return text
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r?\n/g, '\\n');
}

function utc(seconds) {
    return GLib.DateTime.new_from_unix_utc(seconds).format('%Y%m%dT%H%M%SZ');
}

function buildEvent({summary, allDay, start, end}) {
    const stamp = utc(GLib.get_real_time() / 1e6 | 0);
    const uid = GLib.uuid_string_random();
    const lines = [
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTAMP:${stamp}`,
        allDay ? `DTSTART;VALUE=DATE:${start}` : `DTSTART:${utc(start)}`,
        allDay ? `DTEND;VALUE=DATE:${end}` : `DTEND:${utc(end)}`,
        `SUMMARY:${escapeText(summary)}`,
        'END:VEVENT',
    ];
    return ICalGLib.Component.new_from_string(lines.join('\r\n'));
}

function main() {
    const request = JSON.parse(ARGV[0]);
    if (!request.summary?.trim())
        throw new Error('Missing title');

    const registry = EDataServer.SourceRegistry.new_sync(null);
    const source = registry.ref_default_calendar();
    const client = ECal.Client.connect_sync(
        source, ECal.ClientSourceType.EVENTS, CONNECT_TIMEOUT, null);
    if (client.is_readonly())
        throw new Error(`Calendar "${source.get_display_name()}" is read-only`);

    const [, uid] = client.create_object_sync(
        buildEvent(request), ECal.OperationFlags.NONE, null);
    print(uid);
}

// gjs segfaults while tearing down the Evolution libraries, even with an
// explicit exit, so callers must go by the UID on stdout, not the exit status.
try {
    main();
    System.exit(0);
} catch (e) {
    printerr(e.message);
    System.exit(1);
}
