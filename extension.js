import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {BlipWatcher} from './blip.js';
import {PlayerManager} from './mpris.js';
import {Island} from './island.js';

const NEAR_PX = 8;

export default class IslandExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._manager = new PlayerManager();
        this._blip = new BlipWatcher(this._settings);
        this._island = new Island({
            settings: this._settings,
            manager: this._manager,
            blip: this._blip,
            path: this.path,
        });
        Main.layoutManager.addChrome(this._island);
        this._island.start();
        this._blip.start();

        this._watchPanel();

        const island = this._island;
        this._injectionManager = new InjectionManager();
        this._injectionManager.overrideMethod(Main.messageTray, '_showNotification',
            original => function () {
                if (!island.canShowNotifications())
                    return original.call(this);

                const notification = this._notificationQueue[0];
                if (island.notificationBusy && notification !== island.currentNotification)
                    return undefined;

                this._notificationQueue.shift();
                this.emit('queue-changed');
                island.displayNotification(notification);
                return undefined;
            });

        const current = () => this._manager.current;
        this._keybindings = {
            'toggle-island': () => this._island.toggle(),
            'play-pause': () => current()?.playPause(),
            'previous-track': () => current()?.previous(),
            'next-track': () => current()?.next(),
            'seek-backward': () => this._island.seekBy(-1),
            'seek-forward': () => this._island.seekBy(1),
            'next-player': () => this._manager.selectNext(),
            'toggle-calendar': () => this._island.toggleCalendar(),
            'toggle-todo': () => this._island.toggleTodo(),
        };
        for (const [name, handler] of Object.entries(this._keybindings)) {
            Main.wm.addKeybinding(name, this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,

                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
                handler);
        }
    }

    // Panel goes transparent when no window sits at the top of its monitor.
    _watchPanel() {
        const apply = () => {
            const panel = Main.panel;
            const monitor = Main.layoutManager.primaryIndex;
            const limit = panel.height + NEAR_PX;
            const area = Main.layoutManager.primaryMonitor;
            const ws = global.workspace_manager.get_active_workspace();
            const near = ws.list_windows().some(w => {
                if (w.minimized || w.get_monitor() !== monitor)
                    return false;
                if (w.window_type === Meta.WindowType.DESKTOP || w.window_type === Meta.WindowType.DOCK)
                    return false;
                return w.get_frame_rect().y - area.y < limit;
            });
            const clear = this._settings.get_boolean('transparent-top-bar') && !near;
            if (clear)
                panel.set_style('background-color: transparent;');
            else
                panel.set_style(null);
        };
        // Re-check after animations settle; window geometry lags the signals.
        const update = () => {
            apply();
            if (this._panelTimer)
                GLib.source_remove(this._panelTimer);
            this._panelTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                this._panelTimer = 0;
                apply();
                return GLib.SOURCE_REMOVE;
            });
        };

        const track = actor => {
            actor.connectObject(
                'notify::position', update,
                'notify::size', update,
                'notify::visible', update,
                this);
        };
        global.get_window_actors().forEach(track);
        global.display.connectObject(
            'window-created', (_d, w) => {
                const a = w.get_compositor_private();
                if (a)
                    track(a);
                update();
            },
            'restacked', update,
            'notify::focus-window', update,
            this);
        global.workspace_manager.connectObject('workspace-switched', update, this);
        global.window_manager.connectObject(
            'switch-workspace', update,
            'size-changed', update,
            'map', update,
            'minimize', update,
            'unminimize', update,
            'destroy', update,
            this);
        Main.layoutManager.connectObject('monitors-changed', update, this);
        Main.panel.connectObject('notify::height', update, this);
        this._settings.connectObject('changed::transparent-top-bar', update, this);
        update();
    }

    disable() {
        global.get_window_actors().forEach(a => a.disconnectObject(this));
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.panel.disconnectObject(this);
        this._settings.disconnectObject(this);
        Main.panel.set_style(null);
        if (this._panelTimer)
            GLib.source_remove(this._panelTimer);
        this._panelTimer = 0;

        this._injectionManager.clear();
        this._injectionManager = null;

        for (const name of Object.keys(this._keybindings))
            Main.wm.removeKeybinding(name);
        this._keybindings = null;

        this._blip.destroy();
        this._blip = null;
        this._island.destroy();
        this._island = null;
        this._manager.destroy();
        this._manager = null;
        this._settings = null;
    }
}
