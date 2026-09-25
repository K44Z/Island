import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as GrabHelper from 'resource:///org/gnome/shell/ui/grabHelper.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ArtCache} from './art.js';
import {byName} from './mpris.js';

const COMPACT_WIDTH = 236;
const COMPACT_HEIGHT = 34;
const EXPANDED_WIDTH = 400;
const EXPANDED_RADIUS = 28;
const PANEL_GAP = 6;

const EXPAND_DURATION = 420;
const COLLAPSE_DURATION = 320;
const HOVER_EXPAND_DELAY = 120;
const HOVER_COLLAPSE_DELAY = 350;

const AUTO_COLLAPSE_DELAY = 4000;

const PAUSED_HIDE_DELAY = 8000;

const GONE_HIDE_DELAY = 1500;

const EQ_BARS = 4;
const EQ_INTERVAL = 170;
const POSITION_INTERVAL = 1000;

function formatTime(us) {
    const total = Math.max(0, Math.floor(us / 1e6));
    const h = Math.floor(total / 3600);
    const m = Math.floor(total / 60) % 60;
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function makeButton(iconName, styleClass, accessibleName) {
    const icon = new St.Icon({icon_name: iconName, style_class: `${styleClass}-icon`});
    const button = new St.Button({
        style_class: `island-button ${styleClass}`,
        child: icon,
        can_focus: true,
        accessible_name: accessibleName,
    });
    return button;
}

function makeSeekButton(extensionPath, forward) {
    const direction = forward ? 'forward' : 'back';
    const icon = new St.Icon({
        gicon: new Gio.FileIcon({
            file: Gio.File.new_for_path(
                `${extensionPath}/icons/island-seek-${direction}-symbolic.svg`),
        }),
        style_class: 'island-seek-icon',
    });
    const label = new St.Label({
        style_class: 'island-seek-label',
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
    const box = new St.Widget({layout_manager: new Clutter.BinLayout()});
    box.add_child(icon);
    box.add_child(label);
    const button = new St.Button({
        style_class: 'island-button island-seek-button',
        child: box,
        can_focus: true,
        accessible_name: forward ? _('Seek forward') : _('Seek backward'),
    });
    return [button, label];
}

const Artwork = GObject.registerClass(
class Artwork extends St.Bin {
    constructor(styleClass) {
        super({
            style_class: `island-art ${styleClass}`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._placeholder = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            style_class: 'island-art-placeholder',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this.set_child(this._placeholder);
    }

    setPath(path) {
        this._placeholder.visible = !path;
        this.set_style(path ? `background-image: url("${path}");` : null);
    }
});

export const Island = GObject.registerClass(
class Island extends St.Widget {
    constructor({settings, manager, path}) {
        super({
            style_class: 'island',
            reactive: true,
            track_hover: true,
            visible: false,
            opacity: 0,
            layout_manager: new Clutter.BinLayout(),
            pivot_point: new Graphene.Point({x: 0.5, y: 0}),
        });

        this._settings = settings;
        this._manager = manager;
        this._path = path;
        this._art = new ArtCache();

        this._grabHelper = new GrabHelper.GrabHelper(this, {actionMode: Shell.ActionMode.POPUP});

        this._shown = false;
        this._suppressed = false;
        this._expanded = false;
        this._dragging = false;
        this._pausedLongEnough = false;
        this._player = null;
        this._trackKey = null;
        this._position = 0;
        this._artToken = 0;
        this._timeouts = new Map();
        this._playerChips = [];

        this._buildUi();

        this.connect('notify::hover', () => this._onHoverChanged());
        this.connect('notify::width', () => this._reposition());
        this.connect('notify::x', () => this._updateClock(false));
        this.connect('notify::height', () => this._updateRadius());
        this.connect('destroy', () => this._onDestroy());

        this._manager.connectObject(
            'changed', () => this._sync(),
            'current-changed', () => this._onCurrentChanged(), this);
        this._settings.connectObject(
            'changed::placement', () => this._updateGeometry(),
            'changed::clock-left', () => this._placeClock(),
            'changed::seek-step', () => this._syncSeekLabels(),
            'changed::hide-when-paused', () => this._updateVisibility(), this);
        Main.layoutManager.connectObject('monitors-changed',
            () => this._updateGeometry(), this);
        Main.panel.connectObject('notify::height',
            () => this._updateGeometry(), this);

        Main.panel.statusArea.dateMenu?.container.connectObject('notify::width',
            () => this._updateClock(false), this);

        Main.sessionMode.connectObject('updated', () => this._placeClock(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject('notify::scale-factor',
            () => this._updateGeometry(), this);
        global.display.connectObject('in-fullscreen-changed',
            () => this._updateVisibility(), this);
        Main.overview.connectObject(
            'showing', () => this._updateVisibility(),
            'hidden', () => this._updateVisibility(), this);
    }

    start() {
        this._placeClock();
        this._updateGeometry();
        this._syncSeekLabels();
        this._onCurrentChanged();
    }

    _buildUi() {

        this._clip = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
            x_expand: true,
            y_expand: true,
        });
        this.add_child(this._clip);

        this._buildCompact();
        this._buildExpanded();
    }

    _buildCompact() {
        this._compact = new St.Button({
            style_class: 'island-compact',
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            accessible_name: _('Now playing'),
        });
        this._compact.connect('clicked', (_button, clickedButton) => {
            if (clickedButton === Clutter.BUTTON_MIDDLE)
                this._player?.playPause();
            else
                this.setExpanded(true);
        });
        this._clip.add_child(this._compact);

        const box = new St.BoxLayout({style_class: 'island-compact-box', x_expand: true});
        this._compact.set_child(box);

        this._compactArt = new Artwork('island-art-small');
        box.add_child(this._compactArt);

        this._compactTitle = new St.Label({
            style_class: 'island-compact-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._compactTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(this._compactTitle);

        this._eq = new St.BoxLayout({
            style_class: 'island-eq',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._eqBars = [];
        for (let i = 0; i < EQ_BARS; i++) {
            const bar = new St.Widget({
                style_class: 'island-eq-bar',
                y_align: Clutter.ActorAlign.CENTER,
                pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
                scale_y: 0.3,
            });
            this._eq.add_child(bar);
            this._eqBars.push(bar);
        }
        box.add_child(this._eq);
    }

    _buildExpanded() {
        this._expandedBox = new St.BoxLayout({
            style_class: 'island-expanded',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            opacity: 0,
            visible: false,
        });
        this._clip.add_child(this._expandedBox);

        const header = new St.BoxLayout({style_class: 'island-header'});
        this._expandedBox.add_child(header);

        this._bigArt = new Artwork('island-art-large');
        const artButton = new St.Button({
            style_class: 'island-art-button',
            child: this._bigArt,
            can_focus: true,
            accessible_name: _('Open player'),
        });
        artButton.connect('clicked', () => this._raisePlayer());
        header.add_child(artButton);

        const text = new St.BoxLayout({
            style_class: 'island-text',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(text);
        this._titleLabel = new St.Label({style_class: 'island-title'});
        this._artistLabel = new St.Label({style_class: 'island-artist'});
        this._albumLabel = new St.Label({style_class: 'island-album'});
        for (const label of [this._titleLabel, this._artistLabel, this._albumLabel]) {
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            text.add_child(label);
        }

        this._appIcon = new St.Icon({style_class: 'island-app-icon'});
        this._appButton = new St.Button({
            style_class: 'island-button island-app-button',
            child: this._appIcon,
            y_align: Clutter.ActorAlign.START,
            can_focus: true,
        });
        this._appButton.connect('clicked', () => this._raisePlayer());
        header.add_child(this._appButton);

        this._progressBox = new St.BoxLayout({
            style_class: 'island-progress-box',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._expandedBox.add_child(this._progressBox);

        this._progress = new Slider.Slider(0);
        this._progress.add_style_class_name('island-progress');
        this._progress.accessible_name = _('Position');
        this._progress.connect('drag-begin', () => {
            this._dragging = true;
            this._seekingByDrag = true;
        });
        this._progress.connect('drag-end', () => {
            this._dragging = false;
            this._seekingByDrag = false;
            const player = this._player;
            if (player?.length > 0) {
                const target = this._progress.value * player.length;
                player.setPosition(target, this._position);
                this._setPosition(target);
            }
            this._onHoverChanged();
        });
        this._progress.connect('notify::value', () => {
            if (this._seekingByDrag && this._player)
                this._updateTimeLabels(this._progress.value * this._player.length);
        });
        this._progressBox.add_child(this._progress);

        const times = new St.BoxLayout({style_class: 'island-times'});
        this._elapsedLabel = new St.Label({style_class: 'island-time', x_expand: true});
        this._remainingLabel = new St.Label({style_class: 'island-time'});
        times.add_child(this._elapsedLabel);
        times.add_child(this._remainingLabel);
        this._progressBox.add_child(times);

        const controls = new St.BoxLayout({
            style_class: 'island-controls',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._expandedBox.add_child(controls);

        this._shuffleButton = makeButton('media-playlist-shuffle-symbolic',
            'island-toggle', _('Shuffle'));
        this._shuffleButton.connect('clicked', () => this._player?.toggleShuffle());

        let backLabel, forwardLabel;
        [this._backButton, backLabel] = makeSeekButton(this._path, false);
        this._backButton.connect('clicked', () => this.seekBy(-1));

        this._prevButton = makeButton('media-skip-backward-symbolic',
            'island-skip', _('Previous track'));
        this._prevButton.connect('clicked', () => this._player?.previous());

        this._playButton = makeButton('media-playback-start-symbolic',
            'island-play', _('Play or pause'));
        this._playButton.connect('clicked', () => this._player?.playPause());

        this._nextButton = makeButton('media-skip-forward-symbolic',
            'island-skip', _('Next track'));
        this._nextButton.connect('clicked', () => this._player?.next());

        [this._forwardButton, forwardLabel] = makeSeekButton(this._path, true);
        this._seekLabels = [backLabel, forwardLabel];
        this._forwardButton.connect('clicked', () => this.seekBy(1));

        this._repeatButton = makeButton('media-playlist-repeat-symbolic',
            'island-toggle', _('Repeat'));
        this._repeatButton.connect('clicked', () => this._player?.cycleLoop());

        for (const button of [this._shuffleButton, this._backButton, this._prevButton,
            this._playButton, this._nextButton, this._forwardButton, this._repeatButton])
            controls.add_child(button);

        this._switcher = new St.BoxLayout({
            style_class: 'island-switcher',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._expandedBox.add_child(this._switcher);
    }

    _updateGeometry() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const topBar = this._settings.get_string('placement') === 'top-bar';

        this._compactWidth = COMPACT_WIDTH * scale;
        this._compactHeight = topBar
            ? Math.max(24 * scale, Main.panel.height - 6 * scale)
            : COMPACT_HEIGHT * scale;
        this._expandedWidth = EXPANDED_WIDTH * scale;
        this._maxRadius = EXPANDED_RADIUS * scale;
        this._gap = PANEL_GAP * scale;
        this._topBar = topBar;

        this._compact.set_size(this._compactWidth, this._compactHeight);
        this._expandedBox.width = this._expandedWidth;
        this._resize(false);
        this._reposition();
        this._updateClock(true);
    }

    _targetSize() {
        if (!this._expanded)
            return [this._compactWidth, this._compactHeight];
        const [, height] = this._expandedBox.get_preferred_height(this._expandedWidth);
        return [this._expandedWidth, height];
    }

    _resize(animate) {
        const [width, height] = this._targetSize();
        if (width === this.width && height === this.height && !this._resizing)
            return;

        if (!animate) {
            this.remove_transition('width');
            this.remove_transition('height');
            this.set_size(width, height);
            return;
        }

        this._resizing = true;
        this.ease({
            width,
            height,
            duration: this._expanded ? EXPAND_DURATION : COLLAPSE_DURATION,
            mode: this._expanded
                ? Clutter.AnimationMode.EASE_OUT_BACK
                : Clutter.AnimationMode.EASE_OUT_QUINT,
            onStopped: () => {
                this._resizing = false;
            },
        });
    }

    _reposition() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || this._compactHeight === undefined)
            return;

        const panelHeight = Main.panel.height;
        const y = this._topBar
            ? monitor.y + Math.round((panelHeight - this._compactHeight) / 2)
            : monitor.y + panelHeight + this._gap;
        const x = monitor.x + Math.round((monitor.width - this.width) / 2);
        this.set_position(x, y);
    }

    _placeClock() {
        const clock = Main.panel.statusArea.dateMenu?.container;
        if (!clock)
            return;

        const leftBox = Main.panel._leftBox;
        const wantLeft = this._settings.get_boolean('clock-left');
        const parent = clock.get_parent();

        if (wantLeft && parent !== leftBox) {
            this._clockHome = {parent, index: parent?.get_children().indexOf(clock) ?? 0};
            parent?.remove_child(clock);
            leftBox.add_child(clock);
        } else if (!wantLeft && parent === leftBox) {
            this._restoreClock();
        }
        this._updateClock(false);
    }

    _restoreClock() {
        const clock = Main.panel.statusArea.dateMenu?.container;
        if (!clock || !this._clockHome || clock.get_parent() !== Main.panel._leftBox)
            return;

        const {parent, index} = this._clockHome;
        this._clockHome = null;
        clock.get_parent().remove_child(clock);
        (parent ?? Main.panel._centerBox).insert_child_at_index(clock, index);
    }

    _updateClock(animate) {
        const clock = Main.panel.statusArea.dateMenu?.container;
        if (!clock)
            return;

        let offset = 0;
        if (this._topBar && this._shown && clock.get_parent() !== Main.panel._leftBox) {
            const [x] = clock.get_transformed_position();
            const right = x - clock.translation_x + clock.width;
            offset = Math.min(0, this.x - this._gap - right);
        }

        if (!Number.isFinite(offset))
            return;

        if (animate) {
            clock.ease({
                translation_x: offset,
                duration: 300,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            clock.remove_transition('translation-x');
            clock.translation_x = offset;
        }
    }

    _updateRadius() {
        const radius = Math.min(this.height / 2, this._maxRadius ?? EXPANDED_RADIUS);
        this.set_style(`border-radius: ${Math.round(radius)}px;`);
    }

    get expanded() {
        return this._expanded;
    }

    setExpanded(expanded) {
        this._clearTimeout('expand');
        this._clearTimeout('collapse');
        if (!this._shown || this._expanded === expanded)
            return;

        this._expanded = expanded;
        const [incoming, outgoing] = expanded
            ? [this._expandedBox, this._compact]
            : [this._compact, this._expandedBox];

        incoming.show();
        incoming.ease({
            opacity: 255,
            duration: expanded ? 260 : 200,
            delay: expanded ? 60 : 80,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        outgoing.ease({
            opacity: 0,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => outgoing.hide(),
        });

        this._resize(true);
        this._syncTimers();
        if (expanded) {
            this._grabHelper.grab({actor: this, onUngrab: () => this.setExpanded(false)});
            this._refreshPosition();
        } else {
            this._grabHelper.ungrab({actor: this});
        }
    }

    _raisePlayer() {
        const player = this._player;
        this.setExpanded(false);
        player?.raise();
    }

    toggle() {
        if (!this._shown)
            return;
        this.setExpanded(!this._expanded);
        if (this._expanded && !this.hover)
            this._startTimeout('collapse', AUTO_COLLAPSE_DELAY, () => this.setExpanded(false));
    }

    _onHoverChanged() {
        if (this.hover) {
            this._clearTimeout('collapse');
            if (this._settings.get_boolean('expand-on-hover') && !this._expanded)
                this._startTimeout('expand', HOVER_EXPAND_DELAY, () => this.setExpanded(true));
        } else {
            this._clearTimeout('expand');
            if (this._expanded && !this._dragging)
                this._startTimeout('collapse', HOVER_COLLAPSE_DELAY, () => this.setExpanded(false));
        }
        this._updateVisibility();
    }

    _updateVisibility() {
        const players = this._manager.players;
        const monitor = Main.layoutManager.primaryMonitor;
        const fullscreen = !!monitor?.inFullscreen && !Main.overview.visible;
        const anyPlaying = players.some(p => p.isPlaying);

        if (this._player) {
            this._clearTimeout('gone');
            this._goneLongEnough = false;
        } else if (this._shown && !this._goneLongEnough && !this._timeouts.has('gone')) {
            this._startTimeout('gone', GONE_HIDE_DELAY, () => {
                this._goneLongEnough = true;
                this._updateVisibility();
            });
        }
        const hasPlayer = !!this._player || (this._shown && !this._goneLongEnough);

        let wanted = hasPlayer;

        if (wanted && !anyPlaying && this._settings.get_boolean('hide-when-paused')) {
            if (this.hover || this._dragging) {
                this._clearTimeout('paused');
            } else if (!this._pausedLongEnough && !this._timeouts.has('paused')) {
                this._startTimeout('paused', PAUSED_HIDE_DELAY, () => {
                    this._pausedLongEnough = true;
                    this._updateVisibility();
                });
            }
            wanted = !this._pausedLongEnough;
        } else {
            this._clearTimeout('paused');
            this._pausedLongEnough = false;
        }

        if (wanted)
            this._show();
        else
            this._hide();
        this._setSuppressed(fullscreen);
    }

    _setSuppressed(suppressed) {
        if (this._suppressed === suppressed)
            return;
        this._suppressed = suppressed;

        if (suppressed)
            this.setExpanded(false);
        if (this._shown) {
            this.remove_all_transitions();
            this.set({visible: !suppressed, opacity: 255, scale_x: 1, scale_y: 1});
            this._resize(false);
            this._reposition();
        }
    }

    _show() {
        if (this._shown)
            return;
        this._shown = true;

        this._expanded = false;
        this._compact.set({visible: true, opacity: 255});
        this._expandedBox.set({visible: false, opacity: 0});
        this._resize(false);
        this._reposition();

        if (this._suppressed) {

            this.set({visible: false, opacity: 255, scale_x: 1, scale_y: 1});
        } else {
            this.show();
            this.set({scale_x: 0.5, scale_y: 0.5});
            this.ease({
                opacity: 255,
                scale_x: 1,
                scale_y: 1,
                duration: 360,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        }
        this._updateClock(true);
        this._syncTimers();
    }

    _hide() {
        if (!this._shown)
            return;
        this._shown = false;
        this._clearTimeout('expand');
        this._clearTimeout('collapse');
        this._grabHelper.ungrab({actor: this});

        this.ease({
            opacity: 0,
            scale_x: 0.5,
            scale_y: 0.5,
            duration: 220,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => this.hide(),
        });
        this._updateClock(true);
        this._syncTimers();
    }

    _onCurrentChanged() {
        this._player?.disconnectObject(this);
        this._player = this._manager.current;
        this._player?.connectObject('seeked',
            (_player, position) => this._setPosition(position), this);
        this._trackKey = null;
        this._sync();
        this._refreshPosition();
    }

    _sync() {
        const player = this._player;
        this._syncSwitcher();

        if (player) {
            this._syncTrack(player);
            this._syncControls(player);
        }

        this._updateVisibility();
        this._syncTimers();
        if (this._expanded)
            this._resize(true);
    }

    _syncTrack(player) {
        const title = player.title || _('Unknown title');
        const artists = player.artists.join(', ');

        this._compactTitle.text = player.title || player.name;
        this._titleLabel.text = title;
        this._artistLabel.text = artists || player.name;
        this._albumLabel.text = player.album;
        this._albumLabel.visible = !!player.album;
        this._appIcon.gicon = player.gicon;
        this._appButton.accessible_name = player.name;

        const key = `${player.busName}\n${player.trackId}\n${player.title}\n${player.artUrl}`;
        if (key === this._trackKey)
            return;
        const trackChanged = this._trackKey !== null;
        this._trackKey = key;

        this._loadArt(player.artUrl);
        this._refreshPosition();
        if (trackChanged && this._shown && !this._expanded)
            this._pulse();
    }

    async _loadArt(url) {
        const token = ++this._artToken;
        const path = await this._art.resolve(url);
        if (token !== this._artToken)
            return;
        this._compactArt.setPath(path);
        this._bigArt.setPath(path);
    }

    _syncControls(player) {
        this._playButton.child.icon_name = player.isPlaying
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
        this._playButton.reactive = player.canPlayPause;
        this._prevButton.reactive = player.canGoPrevious;
        this._nextButton.reactive = player.canGoNext;
        this._backButton.reactive = player.canSeek;
        this._forwardButton.reactive = player.canSeek;

        const shuffle = player.shuffle;
        this._shuffleButton.visible = shuffle !== null;
        this._shuffleButton.checked = !!shuffle;

        const loop = player.loopStatus;
        this._repeatButton.visible = loop !== null;
        this._repeatButton.checked = loop !== null && loop !== 'None';
        this._repeatButton.child.icon_name = loop === 'Track'
            ? 'media-playlist-repeat-song-symbolic'
            : 'media-playlist-repeat-symbolic';

        this._progress.reactive = player.canSeek && player.length > 0;
        this._setPosition(this._position);
    }

    _syncSwitcher() {

        const players = this._manager.players.sort(byName);
        this._switcher.visible = players.length > 1;

        const ids = players.map(p => p.busName).join('\n');
        if (ids !== this._switcherIds) {
            this._switcherIds = ids;
            this._switcher.destroy_all_children();
            this._playerChips = players.map(player => {
                const box = new St.BoxLayout({style_class: 'island-chip-box'});
                const icon = new St.Icon({style_class: 'island-chip-icon'});
                const label = new St.Label({
                    style_class: 'island-chip-label',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                box.add_child(icon);
                box.add_child(label);
                const chip = new St.Button({
                    style_class: 'island-chip',
                    child: box,
                    can_focus: true,
                });
                chip.connect('clicked', () => this._manager.select(player));
                this._switcher.add_child(chip);
                return {chip, icon, label, player};
            });
        }

        const showLabels = players.length <= 3;
        for (const {chip, icon, label, player} of this._playerChips) {
            icon.gicon = player.gicon;
            label.text = player.name;
            label.visible = showLabels;
            chip.accessible_name = player.name;
            chip.checked = player === this._player;
        }
    }

    _syncSeekLabels() {
        const step = String(this._settings.get_int('seek-step'));
        for (const label of this._seekLabels)
            label.text = step;
    }

    _pulse() {
        this.ease({
            scale_x: 1.06,
            scale_y: 1.06,
            duration: 140,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this.ease({
                scale_x: 1,
                scale_y: 1,
                duration: 260,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            }),
        });
    }

    seekBy(direction) {
        const player = this._player;
        if (!player?.canSeek)
            return;
        const offset = direction * this._settings.get_int('seek-step') * 1e6;
        player.seek(offset);
        const target = this._position + offset;
        this._setPosition(player.length > 0
            ? Math.clamp(target, 0, player.length)
            : Math.max(0, target));
    }

    async _refreshPosition() {
        const player = this._player;
        if (!player || !this._expanded)
            return;
        try {
            const position = await player.getPosition();
            if (player === this._player)
                this._setPosition(position);
        } catch {

        }
    }

    _setPosition(position) {
        this._position = position;
        if (this._seekingByDrag)
            return;
        const length = this._player?.length ?? 0;
        this._progress.value = length > 0 ? Math.clamp(position / length, 0, 1) : 0;
        this._updateTimeLabels(position);
    }

    _updateTimeLabels(position) {
        const length = this._player?.length ?? 0;
        this._elapsedLabel.text = formatTime(position);
        this._remainingLabel.text = length > 0 ? `-${formatTime(length - position)}` : '--:--';
    }

    _syncTimers() {
        const playing = this._shown && !!this._player?.isPlaying;

        if (playing && !this._expanded) {
            if (!this._timeouts.has('eq'))
                this._startInterval('eq', EQ_INTERVAL, () => this._animateEq(true));
        } else if (this._timeouts.has('eq')) {
            this._clearTimeout('eq');
            this._animateEq(false);
        }
        if (!playing)
            this._animateEq(false);

        if (playing && this._expanded) {
            if (!this._timeouts.has('position'))
                this._startInterval('position', POSITION_INTERVAL, () => this._refreshPosition());
        } else {
            this._clearTimeout('position');
        }
    }

    _animateEq(active) {
        for (const bar of this._eqBars) {
            bar.ease({
                scale_y: active ? 0.25 + Math.random() * 0.75 : 0.3,
                duration: active ? EQ_INTERVAL : 300,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            });
        }
    }

    _startTimeout(name, delay, callback) {
        this._clearTimeout(name);
        this._timeouts.set(name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timeouts.delete(name);
            callback();
            return GLib.SOURCE_REMOVE;
        }));
    }

    _startInterval(name, interval, callback) {
        this._clearTimeout(name);
        this._timeouts.set(name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
            callback();
            return GLib.SOURCE_CONTINUE;
        }));
    }

    _clearTimeout(name) {
        const id = this._timeouts.get(name);
        if (id)
            GLib.source_remove(id);
        this._timeouts.delete(name);
    }

    _onDestroy() {
        this._grabHelper.ungrab({actor: this});
        const clock = Main.panel.statusArea.dateMenu?.container;
        clock?.remove_transition('translation-x');
        if (clock)
            clock.translation_x = 0;
        this._restoreClock();
        for (const id of this._timeouts.values())
            GLib.source_remove(id);
        this._timeouts.clear();
        this._player?.disconnectObject(this);
        this._player = null;
        this._art.destroy();
    }
});
