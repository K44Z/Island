// The notification history card: everything GNOME's notification list holds,
// newest first, with the same actions (open, dismiss, clear all).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const MAX_ITEMS = 50;
const BODY_MAX = 140;

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
    return text.length > BODY_MAX
        ? `${text.slice(0, BODY_MAX - 1).trimEnd()}…`
        : text;
}

function formatAge(datetime) {
    if (!datetime)
        return '';
    const seconds = Math.max(0, GLib.DateTime.new_now_local().difference(datetime) / 1e6);
    if (seconds < 60)
        return _('now');
    if (seconds < 3600)
        return _('%dm').format(Math.floor(seconds / 60));
    if (seconds < 86400)
        return _('%dh').format(Math.floor(seconds / 3600));
    return datetime.format('%b %-e');
}

function makeIconButton(iconName, styleClass, accessibleName) {
    return new St.Button({
        style_class: `island-button ${styleClass}`,
        child: new St.Icon({icon_name: iconName, style_class: `${styleClass}-icon`}),
        can_focus: true,
        accessible_name: accessibleName,
    });
}

export const NotificationHistory = GObject.registerClass({
    Signals: {
        // The content changed size.
        'changed': {},
        // An item was opened, so the card should close.
        'close-requested': {},
    },
}, class NotificationHistory extends St.BoxLayout {
    constructor() {
        super({
            style_class: 'island-history',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            opacity: 0,
            visible: false,
        });

        const header = new St.BoxLayout({style_class: 'island-events-header'});
        header.add_child(new St.Label({
            style_class: 'island-events-title',
            text: _('Notifications'),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._clear = new St.Button({
            style_class: 'island-history-clear',
            label: _('Clear'),
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: _('Clear all notifications'),
        });
        this._clear.connect('clicked', () => this._clearAll());
        header.add_child(this._clear);
        this.add_child(header);

        this._list = new St.BoxLayout({
            style_class: 'island-history-list',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._scroll = new St.ScrollView({
            style_class: 'island-history-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            // Scrolls with the wheel or touchpad, without drawing a scrollbar.
            vscrollbar_policy: St.PolicyType.EXTERNAL,
        });
        this._scroll.set_child(this._list);
        this.add_child(this._scroll);

        this._rebuildId = 0;
        const tray = Main.messageTray;
        tray.connectObject(
            'source-added', (_tray, source) => {
                this._watch(source);
                this._queueRebuild();
            },
            'source-removed', () => this._queueRebuild(), this);
        for (const source of tray.getSources())
            this._watch(source);

        this.connect('destroy', () => {
            if (this._rebuildId)
                GLib.source_remove(this._rebuildId);
            this._rebuildId = 0;
        });

        this._rebuild();
    }

    // Brings the list up to date, e.g. so the ages are right when it opens.
    refresh() {
        this._scroll.vadjustment.value = 0;
        this._rebuild();
    }

    _watch(source) {
        source.connectObject(
            'notification-added', () => this._queueRebuild(),
            'notification-removed', () => this._queueRebuild(),
            'destroy', () => this._queueRebuild(), this);
    }

    // Several changes often arrive together, e.g. when clearing all.
    _queueRebuild() {
        if (this._rebuildId)
            return;
        this._rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._rebuildId = 0;
            this._rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    _notifications() {
        const all = Main.messageTray.getSources().flatMap(source => source.notifications);
        const time = n => n.datetime?.to_unix() ?? 0;
        return all.sort((a, b) => time(b) - time(a)).slice(0, MAX_ITEMS);
    }

    _rebuild() {
        this._list.destroy_all_children();
        const notifications = this._notifications();

        for (const notification of notifications)
            this._list.add_child(this._buildItem(notification));

        if (notifications.length === 0) {
            this._list.add_child(new St.Label({
                style_class: 'island-event-empty',
                text: _('No notifications'),
            }));
        }
        this._clear.visible = notifications.length > 0;
        this.emit('changed');
    }

    _buildItem(notification) {
        const source = notification.source;
        const item = new St.BoxLayout({style_class: 'island-history-item'});

        const row = new St.BoxLayout({
            style_class: 'island-history-row',
            x_expand: true,
        });
        const main = new St.Button({
            style_class: 'island-history-main',
            child: row,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            can_focus: true,
        });
        main.connect('clicked', () => {
            this.emit('close-requested');
            notification.activate();
        });
        item.add_child(main);

        const icon = notification.gicon ?? source?.icon ??
            new Gio.ThemedIcon({name: 'preferences-system-notifications-symbolic'});
        row.add_child(new St.Icon({
            style_class: 'island-history-icon',
            gicon: icon,
            y_align: Clutter.ActorAlign.START,
        }));

        const text = new St.BoxLayout({
            style_class: 'island-history-text',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(text);

        const meta = new St.BoxLayout({style_class: 'island-history-meta'});
        const sender = new St.Label({
            style_class: 'island-history-sender',
            text: source?.title ?? '',
            x_expand: true,
        });
        sender.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        meta.add_child(sender);
        meta.add_child(new St.Label({
            style_class: 'island-history-age',
            text: formatAge(notification.datetime),
        }));
        text.add_child(meta);

        const title = new St.Label({
            style_class: 'island-history-title',
            text: plainText(notification.title, false),
            x_align: Clutter.ActorAlign.START,
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(title);

        const body = plainText(notification.body, notification.useBodyMarkup);
        if (body) {
            const label = new St.Label({
                style_class: 'island-history-body',
                text: body,
                x_align: Clutter.ActorAlign.START,
            });
            label.clutter_text.set({
                line_wrap: true,
                line_wrap_mode: Pango.WrapMode.WORD_CHAR,
                ellipsize: Pango.EllipsizeMode.NONE,
            });
            text.add_child(label);
        }

        const dismiss = makeIconButton('window-close-symbolic', 'island-history-dismiss', _('Dismiss'));
        dismiss.y_align = Clutter.ActorAlign.START;
        dismiss.connect('clicked', () =>
            notification.destroy(MessageTray.NotificationDestroyedReason.DISMISSED));
        item.add_child(dismiss);

        // Keep the entry current while the notification is updated in place.
        notification.connectObject(
            'notify::title', () => this._queueRebuild(),
            'notify::body', () => this._queueRebuild(),
            'notify::datetime', () => this._queueRebuild(), item);

        return item;
    }

    _clearAll() {
        for (const source of Main.messageTray.getSources())
            source.destroyNonResidentNotifications();
    }
});
