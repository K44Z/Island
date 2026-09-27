// Deletes one event from Evolution Data Server.
//
// Runs as a separate process (`gjs -m remove-event.js '<json>'`) so the shell
// never loads the Evolution libraries itself. Prints 'ok' on success; on
// failure it prints the reason on stderr and nothing on stdout.
//
// Input: {sourceUid, uid, rid}
//   sourceUid: the calendar's source UID
//   uid:       the event's iCalendar UID
//   rid:       recurrence id, for one instance of a recurring event ('' for
//              the whole series)
//
// These three come apart from the event id reported by
// org.gnome.Shell.CalendarServer, which joins them as "sourceUid\nuid\nrid".

import ECal from 'gi://ECal?version=2.0';
import EDataServer from 'gi://EDataServer?version=1.2';
import System from 'system';

const CONNECT_TIMEOUT = 20;

function main() {
    const {sourceUid, uid, rid} = JSON.parse(ARGV[0]);
    if (!sourceUid || !uid)
        throw new Error('Missing event identifier');

    const registry = EDataServer.SourceRegistry.new_sync(null);
    const source = registry.ref_source(sourceUid);
    if (!source)
        throw new Error('Calendar not found');

    const client = ECal.Client.connect_sync(
        source, ECal.ClientSourceType.EVENTS, CONNECT_TIMEOUT, null);
    if (client.is_readonly())
        throw new Error(`Calendar "${source.get_display_name()}" is read-only`);

    client.remove_object_sync(
        uid, rid || null, ECal.ObjModType.ALL, ECal.OperationFlags.NONE, null);
    print('ok');
}

// gjs segfaults while tearing down the Evolution libraries, even with an
// explicit exit, so callers must go by stdout, not the exit status.
try {
    main();
    System.exit(0);
} catch (e) {
    printerr(e.message);
    System.exit(1);
}
