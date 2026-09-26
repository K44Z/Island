import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {PlayerManager} from './mpris.js';
import {Island} from './island.js';

export default class IslandExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._manager = new PlayerManager();
        this._island = new Island({
            settings: this._settings,
            manager: this._manager,
            path: this.path,
        });
        Main.layoutManager.addChrome(this._island);
        this._island.start();

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
        };
        for (const [name, handler] of Object.entries(this._keybindings)) {
            Main.wm.addKeybinding(name, this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,

                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
                handler);
        }
    }

    disable() {
        this._injectionManager.clear();
        this._injectionManager = null;

        for (const name of Object.keys(this._keybindings))
            Main.wm.removeKeybinding(name);
        this._keybindings = null;

        this._island.destroy();
        this._island = null;
        this._manager.destroy();
        this._manager = null;
        this._settings = null;
    }
}
