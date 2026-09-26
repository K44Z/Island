#!/usr/bin/env -S gjs -m
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const args = ARGV.filter(a => !a.startsWith('--'));
const flags = new Set(ARGV.filter(a => a.startsWith('--')));
const [name = 'mock', title = 'Midnight City', artist = 'M83',
    artUrl = ''] = args;
const minimal = flags.has('--minimal');
const glitchy = flags.has('--glitchy');
const flakyLength = flags.has('--flaky-length');
const noLength = flags.has('--no-length');
let dropLength = noLength;
const zeroAfterSeek = flags.has('--zero-after-seek');
let reportZero = false;
let blank = false;

const LENGTH = 243 * 1e6;

const RootIface = `
<node><interface name="org.mpris.MediaPlayer2">
  <method name="Raise"/><method name="Quit"/>
  <property name="CanRaise" type="b" access="read"/>
  <property name="CanQuit" type="b" access="read"/>
  <property name="HasTrackList" type="b" access="read"/>
  <property name="Identity" type="s" access="read"/>
  <property name="DesktopEntry" type="s" access="read"/>
  <property name="SupportedUriSchemes" type="as" access="read"/>
  <property name="SupportedMimeTypes" type="as" access="read"/>
</interface></node>`;

const PlayerIface = `
<node><interface name="org.mpris.MediaPlayer2.Player">
  <method name="Next"/><method name="Previous"/><method name="Pause"/>
  <method name="PlayPause"/><method name="Stop"/><method name="Play"/>
  <method name="Seek"><arg type="x" direction="in" name="Offset"/></method>
  <method name="SetPosition">
    <arg type="o" direction="in" name="TrackId"/><arg type="x" direction="in" name="Position"/>
  </method>
  <signal name="Seeked"><arg type="x" name="Position"/></signal>
  <property name="PlaybackStatus" type="s" access="read"/>
  ${minimal ? '' : `<property name="LoopStatus" type="s" access="readwrite"/>
  <property name="Shuffle" type="b" access="readwrite"/>
  <property name="Volume" type="d" access="readwrite"/>`}
  <property name="Rate" type="d" access="read"/>
  <property name="Metadata" type="a{sv}" access="read"/>
  <property name="Position" type="x" access="read"/>
  <property name="CanGoNext" type="b" access="read"/>
  <property name="CanGoPrevious" type="b" access="read"/>
  <property name="CanPlay" type="b" access="read"/>
  <property name="CanPause" type="b" access="read"/>
  <property name="CanSeek" type="b" access="read"/>
  <property name="CanControl" type="b" access="read"/>
</interface></node>`;

let track = 1;
let status = flags.has('--paused') ? 'Paused' : 'Playing';
let basePos = 37 * 1e6;
let baseTime = GLib.get_monotonic_time();
let loop = 'None';
let shuffle = false;
let volume = 0.7;

const position = () => Math.min(LENGTH, status === 'Playing'
    ? basePos + (GLib.get_monotonic_time() - baseTime) : basePos);
const setPos = p => {
    basePos = Math.max(0, Math.min(LENGTH, p));
    baseTime = GLib.get_monotonic_time();
};

const metadata = () => new GLib.Variant('a{sv}', blank ? {} : {
    'mpris:trackid': new GLib.Variant('o', `/org/mock/track/${track}`),
    ...(dropLength ? {} : {'mpris:length': new GLib.Variant('x', LENGTH)}),
    'xesam:title': new GLib.Variant('s', track === 1 ? title : `${title} (track ${track})`),
    'xesam:artist': new GLib.Variant('as', [artist]),
    'xesam:album': new GLib.Variant('s', 'Hurry Up, We\'re Dreaming'),
    ...(artUrl ? {'mpris:artUrl': new GLib.Variant('s', artUrl)} : {}),
});

const root = {
    Raise() {
        print(`${name}: Raise called`);
    },
    Quit() {
        mainLoop.quit();
    },
    CanRaise: true,
    CanQuit: true,
    HasTrackList: false,
    Identity: `Mock ${name}`,
    DesktopEntry: '',
    SupportedUriSchemes: [],
    SupportedMimeTypes: [],
};

const player = {
    Next() {
        track++;
        setPos(0);
        trackChanged();
    },
    Previous() {
        track = Math.max(1, track - 1);
        setPos(0);
        trackChanged();
    },
    Pause() {
        setPos(position());
        status = 'Paused';
        changed('PlaybackStatus');
    },
    Play() {
        setPos(position());
        status = 'Playing';
        changed('PlaybackStatus');
    },
    PlayPause() {
        if (status === 'Playing')
            this.Pause();
        else
            this.Play();
    },
    Stop() {
        status = 'Stopped';
        setPos(0);
        changed('PlaybackStatus');
    },
    Seek(offset) {
        setPos(position() + offset);
        afterSeek();
        playerObj.emit_signal('Seeked', new GLib.Variant('(x)', [position()]));
    },
    SetPosition(_trackId, pos) {
        setPos(pos);
        afterSeek();
        playerObj.emit_signal('Seeked', new GLib.Variant('(x)', [position()]));
    },
    get PlaybackStatus() {
        return status;
    },
    get LoopStatus() {
        return loop;
    },
    set LoopStatus(v) {
        loop = v;
        changed('LoopStatus');
    },
    get Shuffle() {
        return shuffle;
    },
    set Shuffle(v) {
        shuffle = v;
        changed('Shuffle');
    },
    get Volume() {
        return volume;
    },
    set Volume(v) {
        volume = v;
        changed('Volume');
    },
    Rate: 1,
    get Metadata() {
        return metadata();
    },
    get Position() {
        return reportZero ? 0 : position();
    },
    CanGoNext: true,
    CanGoPrevious: true,
    CanPlay: true,
    CanPause: true,
    CanSeek: true,
    CanControl: true,
};

const rootObj = Gio.DBusExportedObject.wrapJSObject(RootIface, root);
const playerObj = Gio.DBusExportedObject.wrapJSObject(PlayerIface, player);

function afterSeek() {
    reportZero = zeroAfterSeek;
    if (!flakyLength)
        return;
    dropLength = true;
    changed('Metadata');
}

function trackChanged() {
    dropLength = noLength;
    reportZero = false;
    if (!glitchy) {
        changed('Metadata');
        return;
    }
    const previous = status;
    status = 'Stopped';
    blank = true;
    changed('PlaybackStatus');
    changed('Metadata');
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
        status = previous;
        blank = false;
        changed('PlaybackStatus');
        changed('Metadata');
        return GLib.SOURCE_REMOVE;
    });
}

const SIGNATURES = {PlaybackStatus: 's', LoopStatus: 's', Shuffle: 'b', Volume: 'd'};

function changed(prop) {
    const value = prop === 'Metadata'
        ? metadata()
        : new GLib.Variant(SIGNATURES[prop], player[prop]);
    playerObj.emit_property_changed(prop, value);
}

const mainLoop = new GLib.MainLoop(null, false);
rootObj.export(Gio.DBus.session, '/org/mpris/MediaPlayer2');
playerObj.export(Gio.DBus.session, '/org/mpris/MediaPlayer2');
Gio.bus_own_name(Gio.BusType.SESSION, `org.mpris.MediaPlayer2.${name}`,
    Gio.BusNameOwnerFlags.NONE, null, null, () => mainLoop.quit());
print(`mock player "${name}" on the bus, ${status}`);
mainLoop.run();
