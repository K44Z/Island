import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GnomeDesktop from 'gi://GnomeDesktop';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as GrabHelper from 'resource:///org/gnome/shell/ui/grabHelper.js';
import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {formatDateWithCFormatString, formatTime as formatClockTime} from 'resource:///org/gnome/shell/misc/dateUtils.js';

import {ArtCache} from './art.js';
import {openSender} from './blip.js';
import {NotificationHistory} from './history.js';
import {byName} from './mpris.js';


Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

const COMPACT_TITLE_MIN = 24;
const COMPACT_TITLE_MAX = 280;
const COMPACT_HEIGHT = 34;
const EXPANDED_WIDTH = 400;
const EXPANDED_RADIUS = 28;
const PANEL_GAP = 6;

const EXPAND_DURATION = 420;
const SETTLE_OVERSHOOT = 0.04;
const COLLAPSE_DURATION = 320;
const HOVER_EXPAND_DELAY = 120;
const HOVER_COLLAPSE_DELAY = 350;

const AUTO_COLLAPSE_DELAY = 4000;
const CALENDAR_AUTO_COLLAPSE_DELAY = 10000;

const PAUSED_HIDE_DELAY = 8000;

const GONE_HIDE_DELAY = 1500;

const TODO_PRIORITIES = [() => _('none'), () => _('low'), () => _('medium'), () => _('high')];
const NOTIFICATION_WIDTH = 380;
const NOTIFICATION_DURATION = 5000;
const NOTIFICATION_LINGER = 2000;
const NOTIFICATION_BODY_MAX = 140;
const NOTIFICATION_MAX_ACTIONS = 3;

const EVENT_DEFAULT_LENGTH = 3600;
const EVENT_DEFAULT_HOUR = 9;

const EQ_BARS = 4;
const EQ_INTERVAL = 170;
const PROGRESS_INTERVAL = 500;
const POSITION_INTERVAL = 2000;

function formatTime(us) {
    const total = Math.max(0, Math.floor(us / 1e6));
    const h = Math.floor(total / 3600);
    const m = Math.floor(total / 60) % 60;
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function plainText(text, markup) {
    if (!text)
        return '';
    if (markup) {
        text = text.replace(/<[^>]*>/g, '')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&amp;/g, '&');
    }
    text = text.replace(/\s+/g, ' ').trim();
    return text.length > NOTIFICATION_BODY_MAX
        ? `${text.slice(0, NOTIFICATION_BODY_MAX - 1).trimEnd()}…`
        : text;
}

// Parses "14", "14:30", "1430", "2pm", "2:30 PM" into minutes since midnight.
function parseTimeOfDay(text) {
    const match = /^(\d{1,2})(?::?(\d{2}))?\s*([ap])?\.?m?\.?$/i.exec(text.trim());
    if (!match)
        return null;
    let hours = parseInt(match[1], 10);
    const minutes = match[2] ? parseInt(match[2], 10) : 0;
    const meridiem = match[3]?.toLowerCase();
    if (minutes > 59)
        return null;
    if (meridiem) {
        if (hours < 1 || hours > 12)
            return null;
        hours = hours % 12 + (meridiem === 'p' ? 12 : 0);
    } else if (hours > 23) {
        return null;
    }
    return hours * 60 + minutes;
}

function formatDateStamp(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

// Open tasks from high to no priority, then done ones. The sort is stable, so
// tasks in the same group keep the order they were added or dragged into.
// Sorts in place and returns the list.
function sortTodos(list) {
    const rank = t => t.done ? TODO_PRIORITIES.length : TODO_PRIORITIES.length - 1 - (t.priority || 0);
    return list.sort((a, b) => rank(a) - rank(b));
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
    constructor({settings, manager, blip, path}) {
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
        this._blip = blip;
        this._path = path;
        this._art = new ArtCache();

        this._grabHelper = new GrabHelper.GrabHelper(this, {actionMode: Shell.ActionMode.POPUP});

        this._shown = false;
        this._suppressed = false;
        this._view = 'compact';
        this._expanded = false;
        this._mediaWanted = false;
        this._notification = null;
        this._calendarRequested = false;
        this._todoRequested = false;
        this._historyRequested = false;
        this._sendRequested = false;
        this._dragging = false;
        this._pausedLongEnough = false;
        this._player = null;
        this._trackKey = null;
        this._artToken = 0;
        this._timeouts = new Map();
        this._playerChips = [];

        this._buildUi();

        this.connect('notify::hover', () => this._onHoverChanged());
        this.connect('notify::width', () => this._reposition());
        this.connect('notify::height', () => this._updateRadius());
        this.connect('destroy', () => this._onDestroy());

        this._manager.connectObject(
            'changed', () => this._sync(),
            'current-changed', () => this._onCurrentChanged(), this);
        this._blip.connectObject('devices-changed', () => this._renderDevices(), this);
        this._settings.connectObject(
            'changed::placement', () => {
                this._updateGeometry();
                this._updateVisibility();
            },
            'changed::seek-step', () => this._syncSeekLabels(),
            'changed::hide-when-paused', () => this._updateVisibility(),
            'changed::show-notifications', () => {
                if (!this._settings.get_boolean('show-notifications'))
                    this._endNotification();
            },
            'changed::todos', () => this._renderTodos(),
            'changed::show-blip-transfers', () => this._syncSendButton(),
            'changed::transparent-background', () => this._updateTransparency(), this);
        Main.layoutManager.connectObject('monitors-changed',
            () => this._updateGeometry(), this);
        Main.panel.connectObject('notify::height',
            () => this._updateGeometry(), this);

        Main.sessionMode.connectObject('updated', () => this._updateClock(false), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject('notify::scale-factor',
            () => this._updateGeometry(), this);
        global.display.connectObject('in-fullscreen-changed',
            () => this._updateVisibility(), this);
        Main.overview.connectObject(
            'showing', () => this._updateVisibility(),
            'hidden', () => this._updateVisibility(), this);
    }

    start() {
        this._updateGeometry();
        this._syncSeekLabels();
        this._onCurrentChanged();
        this._sortTodos();
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
        this._buildNotification();
        this._buildCalendar();
        this._buildTodo();
        this._buildHistory();
        this._renderTodos();
        this._buildSend();
        this._renderDevices();
        this._updateTransparency();
    }

    _updateTransparency() {
        this.set_style_class_name(this._settings.get_boolean('transparent-background')
            ? 'island island-transparent'
            : 'island');
    }

    _buildCalendar() {
        this._calendarBox = new St.BoxLayout({
            style_class: 'island-calendar',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            opacity: 0,
            visible: false,
        });
        this._clip.add_child(this._calendarBox);

        this._eventSource = Main.sessionMode.showCalendarEvents
            ? new Calendar.DBusEventSource()
            : new Calendar.EmptyEventSource();
        this._eventSource.connectObject('changed', () => this._reloadEvents(), this);

        this._calendar = new Calendar.Calendar();
        this._calendar.setEventSource(this._eventSource);
        this._calendar.connect('selected-date-changed',
            (_calendar, datetime) => this._showEvents(new Date(datetime.to_unix() * 1000)));
        this._calendarBox.add_child(this._calendar);

        const header = new St.BoxLayout({style_class: 'island-events-header'});
        this._eventsTitle = new St.Label({
            style_class: 'island-events-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._eventsTitle);
        this._addEventButton = makeButton(
            'list-add-symbolic', 'island-add-event', _('Add event'));
        this._addEventButton.connect('clicked', () => this._toggleEventForm());
        header.add_child(this._addEventButton);
        this._calendarBox.add_child(header);

        this._eventError = new St.Label({
            style_class: 'island-event-error',
            visible: false,
        });
        this._eventError.clutter_text.line_wrap = true;
        this._calendarBox.add_child(this._eventError);

        this._buildEventForm();

        this._eventsList = new St.BoxLayout({
            style_class: 'island-events-list',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._calendarBox.add_child(this._eventsList);

        const now = new Date();
        this._eventsDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }

    _buildEventForm() {
        this._eventFormOpen = false;
        this._eventSaving = false;

        this._eventForm = new St.BoxLayout({
            style_class: 'island-event-form',
            orientation: Clutter.Orientation.VERTICAL,
            visible: false,
        });

        this._titleEntry = new St.Entry({
            style_class: 'island-entry',
            hint_text: _('Event title'),
            can_focus: true,
            x_expand: true,
        });
        this._eventForm.add_child(this._titleEntry);

        const times = new St.BoxLayout({style_class: 'island-event-times'});
        this._startEntry = new St.Entry({
            style_class: 'island-entry island-time-entry',
            hint_text: _('Start'),
            can_focus: true,
            x_expand: true,
        });
        this._endEntry = new St.Entry({
            style_class: 'island-entry island-time-entry',
            hint_text: _('End'),
            can_focus: true,
            x_expand: true,
        });
        this._allDayButton = new St.Button({
            style_class: 'island-toggle',
            label: _('All day'),
            toggle_mode: true,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._allDayButton.connect('notify::checked', () => {
            this._startEntry.reactive = this._endEntry.reactive = !this._allDayButton.checked;
            this._startEntry.opacity = this._endEntry.opacity = this._allDayButton.checked ? 90 : 255;
        });
        times.add_child(this._startEntry);
        times.add_child(new St.Label({
            style_class: 'island-time-dash',
            text: '–',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        times.add_child(this._endEntry);
        times.add_child(this._allDayButton);
        this._eventForm.add_child(times);

        const actions = new St.BoxLayout({style_class: 'island-event-actions'});
        const cancel = new St.Button({
            style_class: 'island-notification-action',
            label: _('Cancel'),
            x_expand: true,
            can_focus: true,
        });
        cancel.connect('clicked', () => this._closeEventForm());
        this._saveEventButton = new St.Button({
            style_class: 'island-notification-action island-save-event',
            label: _('Add'),
            x_expand: true,
            can_focus: true,
        });
        this._saveEventButton.connect('clicked', () => this._saveEvent());
        actions.add_child(cancel);
        actions.add_child(this._saveEventButton);
        this._eventForm.add_child(actions);

        for (const entry of [this._titleEntry, this._startEntry, this._endEntry])
            entry.clutter_text.connect('activate', () => this._saveEvent());

        this._calendarBox.add_child(this._eventForm);
    }

    _toggleEventForm() {
        if (this._eventFormOpen)
            this._closeEventForm();
        else
            this._openEventForm();
    }

    _openEventForm() {
        const day = this._eventsDate;
        const now = new Date();
        const isToday = formatDateStamp(day) === formatDateStamp(now);
        const hour = isToday ? Math.min(now.getHours() + 1, 23) : EVENT_DEFAULT_HOUR;
        const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour);
        const end = new Date(start.getTime() + EVENT_DEFAULT_LENGTH * 1000);

        this._titleEntry.text = '';
        this._startEntry.text = formatClockTime(start, {timeOnly: true});
        this._endEntry.text = formatClockTime(end, {timeOnly: true});
        this._allDayButton.checked = false;
        this._setEventError(null);

        this._eventFormOpen = true;
        this._eventForm.show();
        this._clearTimeout('collapse');
        this._resize(true);
        this._titleEntry.grab_key_focus();
    }

    _closeEventForm() {
        if (!this._eventFormOpen)
            return;
        this._eventFormOpen = false;
        this._eventForm.hide();
        this._setEventSaving(false);
        if (this._view === 'calendar')
            this._resize(true);
    }

    _setEventError(message) {
        this._eventError.text = message ?? '';
        this._eventError.visible = !!message;
        if (this._view === 'calendar')
            this._resize(true);
    }

    _setEventSaving(saving) {
        this._eventSaving = saving;
        this._saveEventButton.reactive = !saving;
        this._saveEventButton.label = saving ? _('Adding…') : _('Add');
    }

    _readEventForm() {
        const summary = this._titleEntry.text.trim();
        if (!summary)
            return {error: _('Give the event a title')};

        const day = this._eventsDate;
        if (this._allDayButton.checked) {
            const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
            return {request: {
                summary,
                allDay: true,
                start: formatDateStamp(day),
                end: formatDateStamp(next),
            }};
        }

        const from = parseTimeOfDay(this._startEntry.text);
        if (from === null)
            return {error: _('Start time should look like 14:30')};
        const endText = this._endEntry.text.trim();
        const to = endText
            ? parseTimeOfDay(endText)
            : from + EVENT_DEFAULT_LENGTH / 60;
        if (to === null)
            return {error: _('End time should look like 15:30')};
        if (to <= from)
            return {error: _('The event must end after it starts')};

        const at = minutes => new Date(
            day.getFullYear(), day.getMonth(), day.getDate(),
            0, minutes).getTime() / 1000;
        return {request: {summary, allDay: false, start: at(from), end: at(to)}};
    }

    async _saveEvent() {
        if (this._eventSaving)
            return;
        const {request, error} = this._readEventForm();
        if (error) {
            this._setEventError(error);
            return;
        }

        this._setEventError(null);
        this._setEventSaving(true);
        try {
            const process = Gio.Subprocess.new(
                ['gjs', '-m', `${this._path}/add-event.js`, JSON.stringify(request)],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            const [stdout, stderr] = await process.communicate_utf8_async(null, null);
            if (this._destroyed)
                return;
            if (!stdout?.trim())
                throw new Error(stderr?.trim() || _('Could not add the event'));
        } catch (e) {
            if (this._destroyed)
                return;
            this._setEventSaving(false);
            this._setEventError(e.message);
            return;
        }
        this._closeEventForm();
        this._reloadEvents();
    }


    async _deleteEvent(event) {
        const [sourceUid, uid, rid] = event.id.split('\n');
        try {
            const process = Gio.Subprocess.new(
                ['gjs', '-m', `${this._path}/remove-event.js`, JSON.stringify({sourceUid, uid, rid})],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            const [stdout, stderr] = await process.communicate_utf8_async(null, null);
            if (this._destroyed)
                return;
            if (!stdout?.trim())
                throw new Error(stderr?.trim() || _('Could not delete the event'));
        } catch (e) {
            if (this._destroyed)
                return;
            this._setEventError(e.message);
            return;
        }
        this._reloadEvents();
    }

    _resetCalendar() {
        const today = new Date();
        this._calendar.setDate(today);
        this._showEvents(today);
    }

    _showEvents(date) {
        this._eventsDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        this._reloadEvents();
    }

    _reloadEvents() {
        const start = this._eventsDate;
        const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
        const today = new Date();
        const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const dayDiff = Math.round((start - midnight) / 86400000);

        if (dayDiff === 0)
            this._eventsTitle.text = _('Today');
        else if (dayDiff === 1)
            this._eventsTitle.text = _('Tomorrow');
        else if (dayDiff === -1)
            this._eventsTitle.text = _('Yesterday');
        else
            this._eventsTitle.text = formatDateWithCFormatString(start, '%A, %B %-d');

        this._eventsList.destroy_all_children();
        const events = this._eventSource.getEvents(start, end);
        for (const event of events) {
            const row = new St.BoxLayout({style_class: 'island-event'});
            row.add_child(new St.Widget({
                style_class: 'island-event-dot',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            const text = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
            });
            const summary = new St.Label({
                style_class: 'island-event-summary',
                text: event.summary ?? '',
            });
            summary.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            text.add_child(summary);
            text.add_child(new St.Label({
                style_class: 'island-event-time',
                text: this._formatEventTime(event, start, end),
            }));
            row.add_child(text);

            const remove = makeButton('edit-delete-symbolic', 'island-event-remove', _('Delete event'));
            remove.connect('clicked', () => this._deleteEvent(event));
            row.add_child(remove);

            this._eventsList.add_child(row);
        }

        if (events.length === 0) {
            this._eventsList.add_child(new St.Label({
                style_class: 'island-event-empty',
                text: _('No events'),
            }));
        }

        if (this._view === 'calendar')
            this._resize(true);
    }

    _formatEventTime(event, dayStart, dayEnd) {
        if (event.date <= dayStart && event.end >= dayEnd)
            return _('All day');
        const from = formatClockTime(event.date, {timeOnly: true});
        const to = formatClockTime(event.end, {timeOnly: true});
        return event.date.getTime() === event.end.getTime() ? from : `${from} – ${to}`;
    }

    _buildTodo() {
        this._todoBox = new St.BoxLayout({
            style_class: 'island-todo',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            opacity: 0,
            visible: false,
        });
        this._clip.add_child(this._todoBox);

        const header = new St.BoxLayout({style_class: 'island-events-header'});
        header.add_child(new St.Label({
            style_class: 'island-events-title',
            text: _('Todo'),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._todoBox.add_child(header);

        this._todoEntry = new St.Entry({
            style_class: 'island-entry',
            hint_text: _('Add a task…'),
            can_focus: true,
            x_expand: true,
        });
        this._todoEntry.clutter_text.connect('activate', () => this._addTodo());
        this._todoBox.add_child(this._todoEntry);

        this._todoList = new St.BoxLayout({
            style_class: 'island-events-list',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._todoBox.add_child(this._todoList);
    }

    _buildHistory() {
        this._historyBox = new NotificationHistory();
        this._clip.add_child(this._historyBox);
        this._historyBox.connect('changed', () => {
            if (this._view === 'history')
                this._resize(true);
        });
        this._historyBox.connect('close-requested', () => this._setCard(null));
    }

    _loadTodos() {
        try {
            const list = JSON.parse(this._settings.get_string('todos'));
            return Array.isArray(list) ? list : [];
        } catch {
            return [];
        }
    }

    _saveTodos(list) {
        this._settings.set_string('todos', JSON.stringify(list));
    }

    _addTodo() {
        const text = this._todoEntry.text.trim();
        if (!text)
            return;
        const list = this._loadTodos();
        list.push({id: GLib.uuid_string_random(), text, done: false, priority: 0});
        this._saveTodos(sortTodos(list));
        this._todoEntry.text = '';
    }

    _toggleTodo(id) {
        const list = this._loadTodos();
        const item = list.find(t => t.id === id);
        if (!item)
            return;
        item.done = !item.done;
        list.splice(list.indexOf(item), 1);
        list.push(item);
        this._saveTodos(sortTodos(list));
    }

    // Applies the priority order. Done while the list is closed, so a task
    // changed by hand doesn't jump away from under the pointer.
    _sortTodos() {
        const list = this._loadTodos();
        const sorted = sortTodos([...list]);
        if (sorted.some((t, i) => t !== list[i]))
            this._saveTodos(sorted);
    }

    // Cycles none -> low -> medium -> high -> none. The task keeps its place
    // until the list is closed, so it can be cycled several times in a row.
    _cycleTodoPriority(id) {
        const list = this._loadTodos();
        const item = list.find(t => t.id === id);
        if (!item)
            return;
        item.priority = ((item.priority ?? 0) + 1) % TODO_PRIORITIES.length;
        this._saveTodos(list);
    }

    _removeTodo(id) {
        this._saveTodos(this._loadTodos().filter(t => t.id !== id));
    }

    _editTodo(id, row, label) {
        const item = this._loadTodos().find(t => t.id === id);
        if (!item)
            return;

        const entry = new St.Entry({
            style_class: 'island-entry island-todo-edit',
            text: item.text,
            can_focus: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.insert_child_above(entry, label);
        label.hide();

        let finished = false;
        const finish = save => {
            if (finished)
                return;
            finished = true;
            const text = entry.text.trim();
            if (save && text && text !== item.text) {
                const list = this._loadTodos();
                const current = list.find(t => t.id === id);
                if (current) {
                    current.text = text;
                    this._saveTodos(list);
                    return;
                }
            }
            label.show();
            entry.destroy();
            this._resize(true);
        };

        entry.clutter_text.connect('activate', () => finish(true));
        entry.clutter_text.connect('key-focus-out', () => finish(true));
        entry.clutter_text.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            finish(false);
            return Clutter.EVENT_STOP;
        });

        this._resize(true);
        entry.grab_key_focus();
        entry.clutter_text.set_selection(0, -1);
    }

    _moveTodo(from, to) {
        const list = this._loadTodos();
        if (from === to || !list[from] || to < 0 || to >= list.length)
            return;
        list.splice(to, 0, list.splice(from, 1)[0]);
        this._saveTodos(list);
    }

    _beginTodoDrag(handle, row, event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        const rows = this._todoList.get_children();
        const from = rows.indexOf(row);
        if (from < 0 || rows.length < 2)
            return Clutter.EVENT_STOP;

        const tops = rows.map(r => r.y);
        const step = tops[1] - tops[0];
        const last = rows.length - 1;
        const pointerY = e => this._todoList.transform_stage_point(...e.get_coords())[2];
        const startY = pointerY(event);
        let to = from;

        this._dragging = true;
        row.add_style_class_name('dragging');
        const grab = global.stage.grab(handle);

        const finish = () => {
            handle.disconnectObject(grab);
            grab.dismiss();
            this._dragging = false;
            this._onHoverChanged();
        };

        handle.connectObject(
            'motion-event', (_actor, e) => {
                const dy = Math.max(tops[0] - tops[from],
                    Math.min(tops[last] - tops[from], pointerY(e) - startY));
                row.translation_y = dy;

                const center = tops[from] + dy + row.height / 2;
                const wanted = Math.max(0, Math.min(last, Math.floor((center - tops[0]) / step)));
                if (wanted === to)
                    return Clutter.EVENT_STOP;
                to = wanted;

                rows.forEach((r, i) => {
                    if (i === from)
                        return;
                    let shift = 0;
                    if (from < to && i > from && i <= to)
                        shift = -step;
                    else if (from > to && i >= to && i < from)
                        shift = step;
                    r.ease({
                        translation_y: shift,
                        duration: 150,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                });
                return Clutter.EVENT_STOP;
            },
            'button-release-event', () => {
                finish();
                if (to === from) {
                    row.remove_style_class_name('dragging');
                    row.ease({
                        translation_y: 0,
                        duration: 150,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                } else {
                    this._moveTodo(from, to);
                }
                return Clutter.EVENT_STOP;
            },
            'destroy', () => finish(),
            grab);

        return Clutter.EVENT_STOP;
    }

    _renderTodos() {
        this._todoList.destroy_all_children();
        const list = this._loadTodos();

        for (const item of list) {
            const row = new St.BoxLayout({style_class: 'island-todo-item'});

            if (list.length > 1) {
                const handle = new St.Icon({
                    icon_name: 'list-drag-handle-symbolic',
                    style_class: 'island-todo-handle',
                    reactive: true,
                    track_hover: true,
                    y_align: Clutter.ActorAlign.CENTER,
                    accessible_name: _('Drag to reorder'),
                });
                handle.connect('button-press-event',
                    (_actor, event) => this._beginTodoDrag(handle, row, event));
                row.add_child(handle);
            }

            const check = new St.Button({
                style_class: 'island-todo-check',
                can_focus: true,
                child: new St.Icon({
                    icon_name: 'object-select-symbolic',
                    style_class: 'island-todo-check-icon',
                    visible: item.done,
                }),
                accessible_name: item.done ? _('Mark as not done') : _('Mark as done'),
            });
            check.connect('clicked', () => this._toggleTodo(item.id));
            row.add_child(check);

            const priority = TODO_PRIORITIES[item.priority] ? item.priority : 0;
            const flag = new St.Button({
                style_class: 'island-todo-priority',
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
                child: new St.Widget({
                    style_class: `island-todo-priority-dot priority-${priority}`,
                    y_align: Clutter.ActorAlign.CENTER,
                    x_align: Clutter.ActorAlign.CENTER,
                }),
                accessible_name: _('Priority: %s. Click to change').format(
                    TODO_PRIORITIES[priority]()),
            });
            flag.connect('clicked', () => this._cycleTodoPriority(item.id));
            if (item.done)
                flag.opacity = 140;
            row.add_child(flag);

            const label = new St.Label({
                style_class: 'island-todo-text',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                reactive: true,
            });
            label.connect('button-press-event', (_actor, event) => {
                if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                    return Clutter.EVENT_PROPAGATE;
                this._editTodo(item.id, row, label);
                return Clutter.EVENT_STOP;
            });
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            if (item.done) {
                label.clutter_text.set_markup(`<s>${GLib.markup_escape_text(item.text, -1)}</s>`);
                label.opacity = 140;
            } else {
                label.text = item.text;
            }
            row.add_child(label);

            const remove = makeButton('edit-delete-symbolic', 'island-todo-remove', _('Delete task'));
            remove.connect('clicked', () => this._removeTodo(item.id));
            row.add_child(remove);

            this._todoList.add_child(row);
        }

        if (list.length === 0) {
            this._todoList.add_child(new St.Label({
                style_class: 'island-event-empty',
                text: _('No tasks'),
            }));
        }

        if (this._view === 'todo')
            this._resize(true);
    }

    _buildSend() {
        this._sendBox = new St.BoxLayout({
            style_class: 'island-send',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            opacity: 0,
            visible: false,
        });
        this._clip.add_child(this._sendBox);

        const header = new St.BoxLayout({style_class: 'island-events-header'});
        header.add_child(new St.Label({
            style_class: 'island-events-title',
            text: _('Send with Blip'),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._sendBox.add_child(header);

        this._deviceList = new St.BoxLayout({
            style_class: 'island-events-list',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._sendBox.add_child(this._deviceList);
    }

    _renderDevices() {
        this._deviceList.destroy_all_children();
        const devices = this._blip.devices;

        for (const device of devices) {
            const row = new St.BoxLayout({style_class: 'island-device-row', x_expand: true});
            row.add_child(new St.Icon({
                icon_name: device.kind === 'Phone' ? 'phone-symbolic' : 'computer-symbolic',
                style_class: 'island-device-icon',
                y_align: Clutter.ActorAlign.CENTER,
            }));

            const label = new St.Label({
                style_class: 'island-device-name',
                text: device.name || _('Unknown device'),
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            row.add_child(label);

            row.add_child(new St.Label({
                style_class: 'island-device-status',
                text: device.online ? _('Online') : _('Offline'),
                y_align: Clutter.ActorAlign.CENTER,
            }));

            const button = new St.Button({
                style_class: 'island-device',
                child: row,
                x_expand: true,
                can_focus: device.online,
                reactive: device.online,
                opacity: device.online ? 255 : 110,
            });
            button.connect('clicked', () => {
                this._setCard(null);
                openSender(this._path, device);
            });
            this._deviceList.add_child(button);
        }

        if (devices.length === 0) {
            this._deviceList.add_child(new St.Label({
                style_class: 'island-event-empty',
                text: _('No devices found'),
            }));
        }

        if (this._view === 'send')
            this._resize(true);
    }

    _syncSendButton() {
        this._sendButton.visible = this._blip.enabled;
        if (!this._blip.enabled && this._view === 'send')
            this._setCard(null);
    }

    _buildNotification() {
        this._notificationBox = new St.BoxLayout({
            style_class: 'island-notification',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            opacity: 0,
            visible: false,
        });
        this._clip.add_child(this._notificationBox);

        const header = new St.BoxLayout({style_class: 'island-notification-header'});
        this._notificationBox.add_child(header);

        this._senderIcon = new St.Icon({
            style_class: 'island-notification-sender-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._senderIcon);

        this._senderName = new St.Label({
            style_class: 'island-notification-sender',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._senderName.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        header.add_child(this._senderName);

        const close = makeButton('window-close-symbolic', 'island-notification-close', _('Dismiss'));
        close.connect('clicked', () => this._dismissNotification());
        header.add_child(close);

        const row = new St.BoxLayout({
            style_class: 'island-notification-row',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        const main = new St.Button({
            style_class: 'island-notification-main',
            child: row,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            can_focus: true,
        });
        main.connect('clicked', () => this._activateNotification());
        this._notificationBox.add_child(main);

        this._notificationImage = new St.Icon({
            style_class: 'island-notification-image',
            y_align: Clutter.ActorAlign.START,
        });
        row.add_child(this._notificationImage);

        const text = new St.BoxLayout({
            style_class: 'island-notification-text',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(text);

        this._notificationTitle = new St.Label({
            style_class: 'island-notification-title',
            x_align: Clutter.ActorAlign.START,
        });
        this._notificationTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(this._notificationTitle);

        this._notificationBody = new St.Label({
            style_class: 'island-notification-body',
            x_align: Clutter.ActorAlign.START,
        });
        this._notificationBody.clutter_text.set({
            line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            ellipsize: Pango.EllipsizeMode.NONE,
        });
        text.add_child(this._notificationBody);

        this._notificationActions = new St.BoxLayout({style_class: 'island-notification-actions'});
        this._notificationBox.add_child(this._notificationActions);
    }

    _buildCompact() {
        this._compact = new St.Widget({
            style_class: 'island-compact',
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });
        this._clip.add_child(this._compact);

        this._compactBox = new St.BoxLayout({
            style_class: 'island-compact-box',
            x_expand: true,
            y_expand: true,
        });
        this._compact.add_child(this._compactBox);
        this._compactBox.connect('queue-relayout', () => {
            if (!this._timeouts.has('measure'))
                this._startTimeout('measure', 0, () => this._updateCompactWidth());
        });

        this._compactTime = new St.Label({
            style_class: 'island-compact-time',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._wallClock = new GnomeDesktop.WallClock({time_only: true});
        this._wallClock.connectObject('notify::clock', () => this._syncTime(), this);

        this._timeButton = new St.Button({
            style_class: 'island-compact-time-button',
            child: this._compactTime,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
            can_focus: true,
            accessible_name: _('Calendar'),
        });
        this._timeButton.connect('clicked', () => this.showCalendar());
        this._compactBox.add_child(this._timeButton);
        this._syncTime();

        this._mediaButton = new St.Button({
            style_class: 'island-compact-media',
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
            x_expand: true,
            y_expand: true,
            accessible_name: _('Now playing'),
        });
        this._mediaButton.connect('clicked', (_button, clickedButton) => {
            if (clickedButton === Clutter.BUTTON_MIDDLE)
                this._player?.playPause();
            else
                this.setExpanded(true);
        });
        this._compactBox.add_child(this._mediaButton);

        const box = new St.BoxLayout({style_class: 'island-compact-media-box', x_expand: true});
        this._mediaButton.set_child(box);

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

        this._sendButton = makeButton('document-send-symbolic', 'island-compact-send', _('Send with Blip'));
        this._sendButton.y_align = Clutter.ActorAlign.CENTER;
        this._sendButton.connect('clicked', () => this.toggleSend());
        this._compactBox.add_child(this._sendButton);
        this._syncSendButton();

        this._historyButton = makeButton('preferences-system-notifications-symbolic',
            'island-compact-history', _('Notification history'));
        this._historyButton.y_align = Clutter.ActorAlign.CENTER;
        this._historyButton.connect('clicked', () => this.toggleHistory());
        this._compactBox.add_child(this._historyButton);

        this._todoButton = makeButton('view-list-bullet-symbolic', 'island-compact-todo', _('Todo list'));
        this._todoButton.y_align = Clutter.ActorAlign.CENTER;
        this._todoButton.connect('clicked', () => this.toggleTodo());
        this._compactBox.add_child(this._todoButton);
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
            if (player?.length > 0)
                player.setPosition(this._progress.value * player.length);
            this._updateProgress();
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

        this._timeButton.visible = topBar;
        this._topBar = topBar;
        this._scale = scale;
        this._compactWidth = this._measureCompactWidth();
        this._compactHeight = topBar
            ? Math.max(24 * scale, Main.panel.height - 6 * scale)
            : COMPACT_HEIGHT * scale;
        this._expandedWidth = EXPANDED_WIDTH * scale;
        this._notificationWidth = NOTIFICATION_WIDTH * scale;
        this._maxRadius = EXPANDED_RADIUS * scale;
        this._gap = PANEL_GAP * scale;

        this._compact.set_size(this._compactWidth, this._compactHeight);
        this._expandedBox.width = this._expandedWidth;
        this._notificationBox.width = this._notificationWidth;
        this._todoBox.width = this._notificationWidth;
        this._historyBox.width = this._notificationWidth;
        this._sendBox.width = this._notificationWidth;
        this._resize(false);
        this._reposition();
        this._updateClock(true);
    }

    _targetSize() {
        const node = this.get_theme_node();
        const border = node.get_border_width(St.Side.LEFT) + node.get_border_width(St.Side.RIGHT);
        const [width, height] = this._contentSize();
        return [width + border, height];
    }

    _contentSize() {
        if (this._view === 'calendar') {
            const [, width] = this._calendarBox.get_preferred_width(-1);
            const [, height] = this._calendarBox.get_preferred_height(width);
            return [width, height];
        }
        if (this._view === 'notification') {
            const [, height] = this._notificationBox.get_preferred_height(this._notificationWidth);
            return [this._notificationWidth, height];
        }
        if (this._view === 'todo') {
            const [, height] = this._todoBox.get_preferred_height(this._notificationWidth);
            return [this._notificationWidth, height];
        }
        if (this._view === 'history') {
            const [, height] = this._historyBox.get_preferred_height(this._notificationWidth);
            return [this._notificationWidth, height];
        }
        if (this._view === 'send') {
            const [, height] = this._sendBox.get_preferred_height(this._notificationWidth);
            return [this._notificationWidth, height];
        }
        if (this._view === 'expanded') {
            const [, height] = this._expandedBox.get_preferred_height(this._expandedWidth);
            return [this._expandedWidth, height];
        }
        return [this._compactWidth, this._compactHeight];
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
        const done = () => {
            this._resizing = false;
        };
        if (this._view !== 'compact') {
            this._easeSettle({width, height}, EXPAND_DURATION, done);
            return;
        }
        this.ease({
            width,
            height,
            duration: COLLAPSE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUINT,
            onStopped: done,
        });
    }

    _easeSettle(target, duration, onDone) {
        const overshoot = {};
        for (const [key, value] of Object.entries(target))
            overshoot[key] = value + (value - this[key]) * SETTLE_OVERSHOOT;

        this.ease({
            ...overshoot,
            duration: Math.round(duration * 0.7),
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: finished => {
                if (!finished) {
                    onDone?.();
                    return;
                }
                this.ease({
                    ...target,
                    duration: Math.round(duration * 0.3),
                    mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                    onStopped: () => onDone?.(),
                });
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

        // Moving/resizing the actor under a stationary pointer doesn't fire a
        // crossing event, so `hover` can get stuck true (most noticeably: a
        // notification that never auto-dismisses because _scheduleNotificationEnd
        // refuses to arm while hover is true). Re-sync it against the pointer's
        // actual position every time we move.
        this.sync_hover();
    }

    _syncTime() {
        const date = GLib.DateTime.new_now_local().format('%b %-e');
        this._compactTime.text = `${date}  ${this._wallClock.clock.trim()}`;

        this._updateCompactWidth();
    }

    _measureCompactWidth() {
        const scale = this._scale ?? 1;
        const [, boxWidth] = this._compactBox.get_preferred_width(-1);
        const padding = this._compact.get_theme_node().get_horizontal_padding();
        if (!this._mediaButton.visible)
            return Math.ceil(boxWidth + padding);
        const [, titleWidth] = this._compactTitle.get_preferred_width(-1);
        const title = Math.clamp(titleWidth, COMPACT_TITLE_MIN * scale, COMPACT_TITLE_MAX * scale);
        return Math.ceil(boxWidth - titleWidth + title + padding);
    }

    _updateCompactWidth() {
        if (this._compactHeight === undefined)
            return;
        const width = this._measureCompactWidth();
        if (Math.abs(width - this._compactWidth) < 1)
            return;
        this._compactWidth = width;
        this._compact.width = width;
        if (this._view === 'compact')
            this._resize(true);
    }

    _updateClock(animate) {
        const clock = Main.panel.statusArea.dateMenu?.container;
        if (!clock)
            return;

        const replaced = this._topBar && this._shown && !this._suppressed;
        clock.remove_transition('opacity');
        if (replaced) {
            if (animate && clock.visible) {
                clock.ease({
                    opacity: 0,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => clock.hide(),
                });
            } else {
                clock.set({opacity: 0, visible: false});
            }
        } else {
            clock.show();
            if (animate) {
                clock.ease({
                    opacity: 255,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else {
                clock.opacity = 255;
            }
        }
    }

    _updateRadius() {
        const radius = Math.min(this.height / 2, this._maxRadius ?? EXPANDED_RADIUS);
        this.set_style(`border-radius: ${Math.round(radius)}px;`);
    }

    get expanded() {
        return this._expanded;
    }

    _setView(view) {
        if (this._view === view)
            return;

        const actors = {
            compact: this._compact,
            expanded: this._expandedBox,
            notification: this._notificationBox,
            calendar: this._calendarBox,
            todo: this._todoBox,
            history: this._historyBox,
            send: this._sendBox,
        };
        const incoming = actors[view];
        const outgoing = actors[this._view];
        const growing = view !== 'compact';
        this._view = view;

        incoming.show();
        incoming.ease({
            opacity: 255,
            duration: growing ? 260 : 200,
            delay: growing ? 60 : 80,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        outgoing.ease({
            opacity: 0,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => outgoing.hide(),
        });

        this._resize(true);
    }

    setExpanded(expanded) {
        this._setCard(expanded ? 'expanded' : null);
    }

    _setCard(card) {
        this._clearTimeout('expand');
        this._clearTimeout('collapse');
        if (!this._shown || this._notification)
            return;
        const current = this._expanded ? this._view : null;
        if (current === card)
            return;
        if (current === 'todo')
            this._sortTodos();

        this._expanded = card !== null;
        if (card !== 'calendar')
            this._closeEventForm();
        if (card === 'calendar')
            this._resetCalendar();
        this._setView(card ?? 'compact');
        this._syncTimers();

        if (card) {
            this._grabHelper.grab({actor: this, onUngrab: () => this._setCard(null)});
            if (card === 'expanded')
                this._refreshPosition();
            return;
        }

        this._grabHelper.ungrab({actor: this});
        if (this._calendarRequested || this._todoRequested || this._historyRequested || this._sendRequested) {
            this._calendarRequested = false;
            this._todoRequested = false;
            this._historyRequested = false;
            this._sendRequested = false;
            this._updateVisibility();
        }
        this._pullNotifications();
    }

    showCalendar() {
        if (this._notification)
            this._endNotification();
        this._calendarRequested = true;
        this._updateVisibility();
        if (!this._shown || this._suppressed) {
            this._calendarRequested = false;
            return;
        }
        this._setCard('calendar');
    }

    toggleCalendar() {
        if (this._expanded && this._view === 'calendar') {
            this._setCard(null);
            return;
        }
        this.showCalendar();
        if (this._view === 'calendar' && !this.hover)
            this._startTimeout('collapse', CALENDAR_AUTO_COLLAPSE_DELAY, () => this._setCard(null));
    }

    showTodo() {
        if (this._notification)
            this._endNotification();
        this._todoRequested = true;
        this._updateVisibility();
        if (!this._shown || this._suppressed) {
            this._todoRequested = false;
            return;
        }
        this._sortTodos();
        this._setCard('todo');
        this._todoEntry.grab_key_focus();
    }

    toggleTodo() {
        if (this._expanded && this._view === 'todo') {
            this._setCard(null);
            return;
        }
        this.showTodo();
        if (this._view === 'todo' && !this.hover)
            this._startTimeout('collapse', CALENDAR_AUTO_COLLAPSE_DELAY, () => this._setCard(null));
    }

    showHistory() {
        if (this._notification)
            this._endNotification();
        this._historyRequested = true;
        this._updateVisibility();
        if (!this._shown || this._suppressed) {
            this._historyRequested = false;
            return;
        }
        this._historyBox.refresh();
        this._setCard('history');
    }

    toggleHistory() {
        if (this._expanded && this._view === 'history') {
            this._setCard(null);
            return;
        }
        this.showHistory();
        if (this._view === 'history' && !this.hover)
            this._startTimeout('collapse', CALENDAR_AUTO_COLLAPSE_DELAY, () => this._setCard(null));
    }

    showSend() {
        if (this._notification)
            this._endNotification();
        this._sendRequested = true;
        this._updateVisibility();
        if (!this._shown || this._suppressed) {
            this._sendRequested = false;
            return;
        }
        this._setCard('send');
    }

    toggleSend() {
        if (this._expanded && this._view === 'send') {
            this._setCard(null);
            return;
        }
        this.showSend();
        if (this._view === 'send' && !this.hover)
            this._startTimeout('collapse', CALENDAR_AUTO_COLLAPSE_DELAY, () => this._setCard(null));
    }

    get notificationBusy() {
        return !!this._notification || this._expanded;
    }

    get currentNotification() {
        return this._notification;
    }

    canShowNotifications() {
        return this._settings.get_boolean('show-notifications') &&
            !this._suppressed && !!Main.layoutManager.primaryMonitor;
    }

    displayNotification(notification) {
        const update = notification === this._notification;
        if (!update) {
            this._notification?.disconnectObject(this);
            this._notification = notification;
            notification.connectObject(
                'destroy', () => {
                    if (this._notification === notification)
                        this._endNotification();
                },
                'notify::title', () => this._fillNotification(),
                'notify::body', () => this._fillNotification(),
                'notify::gicon', () => this._fillNotification(), this);
        }

        notification.acknowledged = true;
        notification.playSound();
        this._fillNotification();

        this._updateVisibility();
        this._setView('notification');
        this._syncTimers();
        if (update)
            this._pulse();
        this._scheduleNotificationEnd(NOTIFICATION_DURATION);
    }

    _fillNotification() {
        const notification = this._notification;
        if (!notification)
            return;

        const source = notification.source;
        const appIcon = source?.icon ?? null;
        this._senderIcon.gicon = appIcon ??
            new Gio.ThemedIcon({name: 'preferences-system-notifications-symbolic'});
        this._senderName.text = source?.title ?? '';

        const image = notification.gicon;
        const hasImage = !!image && !(appIcon && image.equal(appIcon));
        this._notificationImage.gicon = hasImage ? image : null;
        this._notificationImage.visible = hasImage;

        this._notificationTitle.text = plainText(notification.title, false);

        const body = plainText(notification.body, notification.useBodyMarkup);
        this._notificationBody.text = body;
        this._notificationBody.visible = !!body;

        this._notificationActions.destroy_all_children();
        const actions = notification.actions.slice(0, NOTIFICATION_MAX_ACTIONS);
        for (const action of actions) {
            const button = new St.Button({
                style_class: 'island-notification-action',
                label: action.label,
                x_expand: true,
                can_focus: true,
            });
            button.connect('clicked', () => {
                action.activate();
                this._endNotification();
            });
            this._notificationActions.add_child(button);
        }
        this._notificationActions.visible = actions.length > 0;

        if (this._view === 'notification')
            this._resize(true);
    }

    _scheduleNotificationEnd(delay) {
        this._clearTimeout('notification');
        const notification = this._notification;
        if (!notification || this.hover ||
            notification.urgency === MessageTray.Urgency.CRITICAL)
            return;
        this._startTimeout('notification', delay, () => this._endNotification());
    }

    _dismissNotification() {
        const notification = this._notification;
        if (notification) {
            // An update that arrived while shown is re-queued by the tray and
            // would pop straight back up once this one ends.
            const tray = Main.messageTray;
            const queue = tray._notificationQueue ?? [];
            if (queue.includes(notification)) {
                tray._notificationQueue = queue.filter(n => n !== notification);
                tray.emit('queue-changed');
            }
        }
        this._endNotification();
    }

    _activateNotification() {
        const notification = this._notification;
        if (!notification)
            return;
        this._endNotification();
        notification.activate();
    }

    _endNotification() {
        const notification = this._notification;
        if (!notification)
            return;

        notification.disconnectObject(this);
        this._notification = null;
        this._clearTimeout('notification');

        this._pullNotifications();
        if (this._notification)
            return;

        if ((this._mediaWanted || this._topBar) && this._shown)
            this._setView('compact');
        this._updateVisibility();
        this._syncTimers();
    }

    _pullNotifications() {
        if (this.notificationBusy || !this.canShowNotifications())
            return;
        try {
            Main.messageTray._updateState();
        } catch (e) {
            console.debug(`Island: could not pull notifications: ${e.message}`);
        }
    }

    vfunc_button_press_event(event) {
        if (event.get_button() === Clutter.BUTTON_SECONDARY &&
            (this._view === 'compact' || this._view === 'expanded') && this._player) {
            this._raisePlayer();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _raisePlayer() {
        const player = this._player;
        this.setExpanded(false);
        player?.raise();
    }

    toggle() {
        if (this._notification) {
            this._endNotification();
            return;
        }
        if (!this._shown)
            return;
        this.setExpanded(!this._expanded);
        if (this._expanded && !this.hover)
            this._startTimeout('collapse', AUTO_COLLAPSE_DELAY, () => this.setExpanded(false));
    }

    _onHoverChanged() {
        if (this._notification) {
            if (this.hover)
                this._clearTimeout('notification');
            else
                this._scheduleNotificationEnd(NOTIFICATION_LINGER);
            this._updateVisibility();
            return;
        }

        if (this.hover) {
            this._clearTimeout('collapse');
            if (this._settings.get_boolean('expand-on-hover') && !this._expanded)
                this._startTimeout('expand', HOVER_EXPAND_DELAY, () => {
                    if (!this._timeButton.hover)
                        this.setExpanded(true);
                });
        } else {
            this._clearTimeout('expand');
            if (this._expanded && !this._dragging && !this._eventFormOpen)
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
        } else if (this._mediaWanted && !this._goneLongEnough && !this._timeouts.has('gone')) {
            this._startTimeout('gone', GONE_HIDE_DELAY, () => {
                this._goneLongEnough = true;
                this._updateVisibility();
            });
        }
        const hasPlayer = !!this._player || (this._mediaWanted && !this._goneLongEnough);

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

        const hadMedia = this._mediaWanted;
        this._mediaWanted = wanted;
        this._mediaButton.visible = wanted;
        this._updateCompactWidth();
        if (this._shown && !this._notification && hadMedia !== wanted && wanted)
            this._compact.set({visible: true, opacity: 255});

        if (wanted || this._notification || this._calendarRequested || this._todoRequested || this._historyRequested || this._sendRequested || this._topBar)
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
        this._updateClock(false);
        if (!suppressed)
            this._pullNotifications();
    }

    _show() {
        if (this._shown)
            return;
        this._shown = true;

        this._expanded = false;
        this._view = 'compact';
        this._compact.remove_all_transitions();
        this._expandedBox.remove_all_transitions();
        this._notificationBox.remove_all_transitions();
        this._calendarBox.remove_all_transitions();
        this._todoBox.remove_all_transitions();
        this._historyBox.remove_all_transitions();
        this._sendBox.remove_all_transitions();
        const startInCompact = !this._notification && !this._calendarRequested && !this._todoRequested &&
            !this._historyRequested && !this._sendRequested;
        this._compact.set({visible: true, opacity: startInCompact ? 255 : 0});
        this._expandedBox.set({visible: false, opacity: 0});
        this._notificationBox.set({visible: false, opacity: 0});
        this._calendarBox.set({visible: false, opacity: 0});
        this._todoBox.set({visible: false, opacity: 0});
        this._historyBox.set({visible: false, opacity: 0});
        this._sendBox.set({visible: false, opacity: 0});
        this._resize(false);
        this._reposition();

        if (this._suppressed) {

            this.set({visible: false, opacity: 255, scale_x: 1, scale_y: 1});
        } else {
            this.show();
            this.set({scale_x: 0.5, scale_y: 0.5});
            this.ease({
                opacity: 255,
                duration: 220,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            this._easeSettle({scale_x: 1, scale_y: 1}, 380);
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
        this._player?.connectObject('seeked', () => this._updateProgress(), this);
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
        this._updateCompactWidth();
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
        this._updateProgress();
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
            scale_x: 1.03,
            scale_y: 1.03,
            duration: 160,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this.ease({
                scale_x: 1,
                scale_y: 1,
                duration: 280,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            }),
        });
    }

    seekBy(direction) {
        const player = this._player;
        if (!player?.canSeek)
            return;
        const offset = direction * this._settings.get_int('seek-step') * 1e6;
        player.seek(offset);
        this._updateProgress();
    }

    async _refreshPosition() {
        const player = this._player;
        if (!player || !this._expanded)
            return;
        try {
            await player.refreshPosition();
        } catch {
            return;
        }
        if (player === this._player)
            this._updateProgress();
    }

    _updateProgress() {
        const player = this._player;
        if (!player || this._seekingByDrag)
            return;
        const position = player.position;
        this._progress.value = player.length > 0 ? Math.clamp(position / player.length, 0, 1) : 0;
        this._updateTimeLabels(position);
    }

    _updateTimeLabels(position) {
        const length = this._player?.length ?? 0;
        this._elapsedLabel.text = formatTime(position);
        this._remainingLabel.text = length > 0 ? `-${formatTime(length - position)}` : '--:--';
    }

    _syncTimers() {
        const playing = this._shown && !!this._player?.isPlaying;

        if (playing && this._view === 'compact') {
            if (!this._timeouts.has('eq'))
                this._startInterval('eq', EQ_INTERVAL, () => this._animateEq(true));
        } else if (this._timeouts.has('eq')) {
            this._clearTimeout('eq');
            this._animateEq(false);
        }
        if (!playing)
            this._animateEq(false);

        if (playing && this._view === 'expanded') {
            if (!this._timeouts.has('progress'))
                this._startInterval('progress', PROGRESS_INTERVAL, () => this._updateProgress());
            if (!this._timeouts.has('position'))
                this._startInterval('position', POSITION_INTERVAL, () => this._refreshPosition());
        } else {
            this._clearTimeout('progress');
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
        this._destroyed = true;
        this._grabHelper.ungrab({actor: this});
        this._notification?.disconnectObject(this);
        this._notification = null;
        const clock = Main.panel.statusArea.dateMenu?.container;
        clock?.remove_transition('opacity');
        clock?.set({opacity: 255, visible: true});
        this._eventSource.disconnectObject(this);
        this._eventSource.destroy();
        this._wallClock.disconnectObject(this);
        this._wallClock.run_dispose();
        this._wallClock = null;
        for (const id of this._timeouts.values())
            GLib.source_remove(id);
        this._timeouts.clear();
        this._player?.disconnectObject(this);
        this._player = null;
        this._art.destroy();
    }
});
