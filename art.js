import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.File.prototype, 'delete_async');

const MAX_CACHED = 200;

const UNSAFE_PATH = /["\\\n]/;

export class ArtCache {
    constructor() {
        this._dir = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_cache_dir(), 'island', 'art']));
        this._session = new Soup.Session({timeout: 10});
        this._cancellable = new Gio.Cancellable();
        this._pending = new Map();
        this._prune();
    }

    destroy() {
        this._cancellable.cancel();
        this._session.abort();
        this._pending.clear();
    }

    resolve(url) {
        if (!url)
            return Promise.resolve(null);

        if (url.startsWith('file://')) {
            const path = Gio.File.new_for_uri(url).get_path();
            const ok = path && !UNSAFE_PATH.test(path) &&
                GLib.file_test(path, GLib.FileTest.EXISTS);
            return Promise.resolve(ok ? path : null);
        }

        if (!url.startsWith('http://') && !url.startsWith('https://'))
            return Promise.resolve(null);

        if (!this._pending.has(url)) {
            const promise = this._download(url).finally(() => this._pending.delete(url));
            this._pending.set(url, promise);
        }
        return this._pending.get(url);
    }

    async _download(url) {
        const name = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1);
        const file = this._dir.get_child(name);
        if (file.query_exists(null))
            return file.get_path();

        try {
            const message = Soup.Message.new('GET', url);
            if (!message)
                return null;
            const bytes = await this._session.send_and_read_async(
                message, GLib.PRIORITY_DEFAULT, this._cancellable);
            if (message.get_status() !== Soup.Status.OK || bytes.get_size() === 0)
                return null;

            GLib.mkdir_with_parents(this._dir.get_path(), 0o755);
            await file.replace_contents_bytes_async(bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, this._cancellable);
            return file.get_path();
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`Island: could not fetch cover ${url}: ${e.message}`);
            return null;
        }
    }

    async _prune() {
        try {
            const enumerator = await this._dir.enumerate_children_async(
                'standard::name,time::modified', Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_LOW, this._cancellable);
            const infos = [];
            for (;;) {

                const batch = await enumerator.next_files_async(100, GLib.PRIORITY_LOW, this._cancellable);
                if (batch.length === 0)
                    break;
                infos.push(...batch);
            }
            infos.sort((a, b) =>
                b.get_attribute_uint64('time::modified') - a.get_attribute_uint64('time::modified'));
            await Promise.all(infos.slice(MAX_CACHED).map(info =>
                this._dir.get_child(info.get_name()).delete_async(GLib.PRIORITY_LOW, this._cancellable)));
        } catch (e) {

            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) &&
                !e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`Island: could not prune art cache: ${e.message}`);
        }
    }
}
