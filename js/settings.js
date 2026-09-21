(function () {
    var STORAGE_KEY = 'librewxr.hidden';
    var DEFAULT_HIDDEN = ['source', 'arrows', 'cells'];
    var root = document.documentElement;

    function load() {
        try {
            var parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
            return Array.isArray(parsed) ? parsed : null;
        } catch (e) {
            return null;
        }
    }

    function save(list) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
        } catch (e) {}
    }

    function forget() {
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch (e) {}
    }

    function apply(list) {
        root.setAttribute('data-hide', list.join(' '));
    }

    var hidden = load() || DEFAULT_HIDDEN.slice();
    apply(hidden);

    document.addEventListener('DOMContentLoaded', function () {
        var button = document.getElementById('lv-settings-btn');
        var menu = document.getElementById('lv-settings-menu');
        var reset = document.getElementById('lv-settings-reset');
        if (!button || !menu) return;

        var boxes = Array.prototype.slice.call(menu.querySelectorAll('input[data-key]'));

        function sync() {
            boxes.forEach(function (box) {
                box.checked = hidden.indexOf(box.getAttribute('data-key')) === -1;
            });
        }

        function setOpen(open) {
            menu.hidden = !open;
            button.setAttribute('aria-expanded', open ? 'true' : 'false');
        }

        boxes.forEach(function (box) {
            box.addEventListener('change', function () {
                hidden = boxes
                    .filter(function (b) { return !b.checked; })
                    .map(function (b) { return b.getAttribute('data-key'); });
                apply(hidden);
                save(hidden);
            });
        });

        reset.addEventListener('click', function () {
            hidden = DEFAULT_HIDDEN.slice();
            apply(hidden);
            forget();
            sync();
        });

        button.addEventListener('click', function () {
            setOpen(menu.hidden);
        });

        document.addEventListener('click', function (e) {
            if (menu.hidden) return;
            if (menu.contains(e.target) || button.contains(e.target)) return;
            setOpen(false);
        });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && !menu.hidden) {
                setOpen(false);
                button.focus();
            }
        });

        sync();
    });
})();
