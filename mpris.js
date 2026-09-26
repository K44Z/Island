import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

const IGNORED_PLAYERS = new Set([`${MPRIS_PREFIX}playerctld`]);

const DBusIface = `
<node>
  <interface name="org.freedesktop.DBus">
    <method name="ListNames">
      <arg type="as" direction="out" name="names"/>
    </method>
    <signal name="NameOwnerChanged">
      <arg type="s" name="name"/>
      <arg type="s" name="oldOwner"/>
      <arg type="s" name="newOwner"/>
    </signal>
  </interface>
</node>`;

const MprisIface = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
  </interface>
</node>`;

const PlayerIface = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="PlayPause"/>
    <method name="Seek">
      <arg type="x" direction="in" name="Offset"/>
    </method>
    <method name="SetPosition">
      <arg type="o" direction="in" name="TrackId"/>
      <arg type="x" direction="in" name="Position"/>
    </method>
    <signal name="Seeked">
      <arg type="x" name="Position"/>
    </signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="LoopStatus" type="s" access="readwrite"/>
    <property name="Shuffle" type="b" access="readwrite"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Rate" type="d" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
  </interface>
</node>`;

const DBusProxy = Gio.DBusProxy.makeProxyWrapper(DBusIface);
const MprisProxy = Gio.DBusProxy.makeProxyWrapper(MprisIface);
const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(PlayerIface);

const LOOP_CYCLE = {None: 'Playlist', Playlist: 'Track', Track: 'None'};

const POSITION_HOLD = 1500000;
const POSITION_TOLERANCE = 2000000;

function asString(value) {
    return typeof value === 'string' ? value : '';
}

function asNumber(value) {
    if (typeof value === 'bigint')
        return Number(value);
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asStringList(value) {
    if (typeof value === 'string')
        return value ? [value] : [];
    if (Array.isArray(value))
        return value.filter(v => typeof v === 'string' && v);
    return [];
}

export function byName(a, b) {
    return a.name.localeCompare(b.name) || a.busName.localeCompare(b.busName);
}

function lookupApp(desktopEntry) {
    if (!desktopEntry)
        return null;

    const appSystem = Shell.AppSystem.get_default();
    const id = desktopEntry.endsWith('.desktop') ? desktopEntry : `${desktopEntry}.desktop`;
    const name = id.slice(0, -'.desktop'.length);
    return appSystem.lookup_app(id) ??
        appSystem.lookup_heuristic_basename(id) ??
        appSystem.lookup_desktop_wmclass(name) ??
        appSystem.lookup_startup_wmclass(name);
}

export const MprisPlayer = GObject.registerClass({
    Signals: {
        'changed': {},
        'seeked': {param_types: [GObject.TYPE_DOUBLE]},
    },
}, class MprisPlayer extends GObject.Object {
    constructor(busName) {
        super();

        this.busName = busName;
        this.lastActive = 0;
        this.title = '';
        this.artists = [];
        this.album = '';
        this.artUrl = '';
        this.length = 0;
        this.trackId = '';
        this.app = null;
        this.identity = busName.slice(MPRIS_PREFIX.length).split('.')[0];

        this._cancellable = new Gio.Cancellable();
        this._mprisProxy = null;
        this._playerProxy = null;

        this._wasPlaying = false;
        this._rate = 1;
        this._positionBase = 0;
        this._positionTime = GLib.get_monotonic_time();
        this._positionHoldUntil = 0;
    }

    async init() {
        const bus = Gio.DBus.session;
        [this._mprisProxy, this._playerProxy] = await Promise.all([
            MprisProxy.newAsync(bus, this.busName, MPRIS_PATH, this._cancellable),
            PlayerProxy.newAsync(bus, this.busName, MPRIS_PATH, this._cancellable),
        ]);

        this._mprisProxy.connectObject('g-properties-changed',
            () => this._updateIdentity(), this);
        this._playerProxy.connectObject('g-properties-changed',
            () => this._updateState(), this);
        this._seekedId = this._playerProxy.connectSignal('Seeked',
            (_proxy, _sender, [position]) => {
                this._setPosition(asNumber(position), true);
                this.emit('seeked', this.position);
            });

        this._updateIdentity();
        this._updateState();
    }

    destroy() {
        this._cancellable.cancel();
        this._mprisProxy?.disconnectObject(this);
        this._playerProxy?.disconnectObject(this);
        if (this._seekedId)
            this._playerProxy.disconnectSignal(this._seekedId);
        this._mprisProxy = null;
        this._playerProxy = null;
    }

    get name() {
        return this.app?.get_name() ?? this.identity;
    }

    get gicon() {
        return this.app?.get_icon() ?? new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});
    }

    get status() {
        return this._playerProxy?.PlaybackStatus ?? 'Stopped';
    }

    get isPlaying() {
        return this.status === 'Playing';
    }

    get isActive() {
        return this.status !== 'Stopped' && (this.title !== '' || this.isPlaying);
    }

    get canGoNext() {
        return !!this._playerProxy?.CanGoNext;
    }

    get canGoPrevious() {
        return !!this._playerProxy?.CanGoPrevious;
    }

    get canPlayPause() {
        return !!(this._playerProxy?.CanPlay || this._playerProxy?.CanPause);
    }

    get canSeek() {
        return !!this._playerProxy?.CanSeek;
    }

    get position() {
        let position = this._positionBase;
        if (this._wasPlaying)
            position += (GLib.get_monotonic_time() - this._positionTime) * this._rate;
        return this.length > 0
            ? Math.clamp(position, 0, this.length)
            : Math.max(0, position);
    }

    get shuffle() {
        const value = this._playerProxy?.Shuffle;
        return typeof value === 'boolean' ? value : null;
    }

    get loopStatus() {
        const value = this._playerProxy?.LoopStatus;
        return value in LOOP_CYCLE ? value : null;
    }

    playPause() {
        this._call('PlayPauseAsync');
    }

    next() {
        this._call('NextAsync');
    }

    previous() {
        this._call('PreviousAsync');
    }

    seek(offset) {
        if (!this.canSeek)
            return;
        this._setPosition(this.position + offset, true);
        this._call('SeekAsync', Math.round(offset));
    }

    setPosition(position) {
        if (!this.canSeek)
            return;
        const current = this.position;
        this._setPosition(position, true);
        if (this.trackId && GLib.Variant.is_object_path(this.trackId))
            this._call('SetPositionAsync', this.trackId, Math.round(position));
        else
            this._call('SeekAsync', Math.round(position - current));
    }

    toggleShuffle() {
        if (this.shuffle !== null)
            this._playerProxy.Shuffle = !this.shuffle;
    }

    cycleLoop() {
        if (this.loopStatus !== null)
            this._playerProxy.LoopStatus = LOOP_CYCLE[this.loopStatus];
    }

    raise() {
        if (this._mprisProxy?.CanRaise)
            this._mprisProxy.RaiseAsync().catch(e => console.debug(`Island: Raise failed: ${e.message}`));
        this.app?.activate();
    }

    async refreshPosition() {
        const [value] = (await Gio.DBus.session.call(
            this.busName, MPRIS_PATH,
            'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE, 1000, this._cancellable)).deepUnpack();
        const reported = asNumber(value.unpack());

        if (GLib.get_monotonic_time() < this._positionHoldUntil)
            return;

        const estimate = this.position;
        const nearEnd = this.length > 0 && estimate > this.length - POSITION_TOLERANCE;
        if (reported === 0 && estimate > POSITION_TOLERANCE && !nearEnd)
            return;

        this._setPosition(reported);
    }

    _setPosition(position, hold = false) {
        this._positionBase = this.length > 0
            ? Math.clamp(position, 0, this.length)
            : Math.max(0, position);
        this._positionTime = GLib.get_monotonic_time();
        if (hold)
            this._positionHoldUntil = this._positionTime + POSITION_HOLD;
    }

    _call(method, ...args) {
        this._playerProxy?.[method](...args).catch(e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`Island: ${this.busName} ${method} failed: ${e.message}`);
        });
    }

    _updateIdentity() {
        this.app = lookupApp(this._mprisProxy.DesktopEntry);
        this.identity = this._mprisProxy.Identity || this.identity;
        this.emit('changed');
    }

    _updateState() {
        const metadata = {};
        const raw = this._playerProxy.Metadata ?? {};
        for (const key in raw)
            metadata[key] = raw[key] instanceof GLib.Variant ? raw[key].deepUnpack() : raw[key];

        const playing = this.isPlaying;
        const rate = typeof this._playerProxy.Rate === 'number' ? this._playerProxy.Rate : 1;
        if (playing !== this._wasPlaying || rate !== this._rate) {
            this._setPosition(this.position);
            this._rate = rate;
        }
        if (playing && !this._wasPlaying)
            this.lastActive = GLib.get_monotonic_time();
        this._wasPlaying = playing;

        if (Object.keys(metadata).length > 0 || this.status === 'Stopped')
            this._applyMetadata(metadata);

        this.emit('changed');
    }

    _applyMetadata(metadata) {
        const title = asString(metadata['xesam:title']);
        const trackId = asString(metadata['mpris:trackid']);
        const length = asNumber(metadata['mpris:length']);
        const sameTrack = title === this.title && trackId === this.trackId;

        this.title = title;
        this.trackId = trackId;
        this.artists = asStringList(metadata['xesam:artist']);
        this.album = asString(metadata['xesam:album']);
        this.artUrl = asString(metadata['mpris:artUrl']);
        this.length = length > 0 || !sameTrack ? length : this.length;
        if (!sameTrack)
            this._setPosition(0);
    }
});

export const PlayerManager = GObject.registerClass({
    Signals: {

        'changed': {},
        'current-changed': {},
    },
}, class PlayerManager extends GObject.Object {
    constructor() {
        super();

        this._players = new Map();

        this._seenActive = new WeakMap();
        this._current = null;

        this._pinned = null;
        this._cancellable = new Gio.Cancellable();
        this._watchBus();
    }

    async _watchBus() {
        try {
            this._proxy = await DBusProxy.newAsync(Gio.DBus.session,
                'org.freedesktop.DBus', '/org/freedesktop/DBus', this._cancellable);
            this._ownerChangedId = this._proxy.connectSignal('NameOwnerChanged',
                (_proxy, _sender, [name, oldOwner, newOwner]) => {
                    if (oldOwner)
                        this._removePlayer(name);
                    if (newOwner)
                        this._addPlayer(name);
                });
            const [names] = await this._proxy.ListNamesAsync();
            names.forEach(name => this._addPlayer(name));
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.error(`Island: failed to watch the session bus: ${e.message}`);
        }
    }

    destroy() {
        this._cancellable.cancel();
        if (this._ownerChangedId)
            this._proxy.disconnectSignal(this._ownerChangedId);
        this._proxy = null;
        for (const player of this._players.values())
            player.destroy();
        this._players.clear();
        this._current = null;
        this._pinned = null;
    }

    get players() {
        return [...this._players.values()]
            .filter(p => p.isActive)
            .sort((a, b) => b.lastActive - a.lastActive);
    }

    get current() {
        return this._current;
    }

    select(player) {
        this._pinned = player;
        this._setCurrent(player);
    }

    selectNext() {
        const players = this.players;
        if (players.length < 2)
            return;
        players.sort(byName);
        const index = players.indexOf(this._current);
        this.select(players[(index + 1) % players.length]);
    }

    async _addPlayer(busName) {
        if (!busName.startsWith(MPRIS_PREFIX) || IGNORED_PLAYERS.has(busName) ||
            this._players.has(busName))
            return;

        const player = new MprisPlayer(busName);
        this._players.set(busName, player);
        try {
            await player.init();
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`Island: could not connect to ${busName}: ${e.message}`);
            this._removePlayer(busName);
            return;
        }

        if (this._players.get(busName) !== player)
            return;
        player.connectObject('changed', () => this._onPlayerChanged(player), this);
        this._onPlayerChanged(player);
    }

    _removePlayer(busName) {
        const player = this._players.get(busName);
        if (!player)
            return;

        this._players.delete(busName);
        player.disconnectObject(this);
        player.destroy();
        if (this._pinned === player)
            this._pinned = null;
        this._pickCurrent();
        this.emit('changed');
    }

    _onPlayerChanged(player) {

        const startedPlaying = player.isPlaying &&
            this._seenActive.get(player) !== player.lastActive;
        this._seenActive.set(player, player.lastActive);

        if (startedPlaying && player !== this._current &&
            !(this._pinned?.isPlaying && this._pinned === this._current)) {
            this._pinned = null;
            this._setCurrent(player);
        } else {
            this._pickCurrent();
        }
        this.emit('changed');
    }

    _pickCurrent() {
        const players = this.players;
        if (this._current && players.includes(this._current))
            return;
        this._setCurrent(players.find(p => p.isPlaying) ?? players[0] ?? null);
    }

    _setCurrent(player) {
        if (this._current === player)
            return;
        this._current = player;
        this.emit('current-changed');
    }
});
