(function (global) {
    var STORAGE_KEY = 'librewxr.location';
    var REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';

    var current = load();
    var listeners = [];

    function valid(loc) {
        return !!loc && typeof loc.lat === 'number' && isFinite(loc.lat) &&
            typeof loc.lon === 'number' && isFinite(loc.lon);
    }

    function load() {
        try {
            var parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
            return valid(parsed) ? parsed : null;
        } catch (e) {
            return null;
        }
    }

    function save(loc) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(loc));
        } catch (e) {}
    }

    function emit() {
        for (var i = 0; i < listeners.length; i++) listeners[i](current);
    }

    function labelFromAddress(address) {
        if (!address) return '';
        var place = address.city || address.town || address.village || address.hamlet ||
            address.suburb || address.municipality || address.county || '';
        return [place, address.state || address.country || ''].filter(Boolean).join(', ');
    }

    function reverseLabel(lat, lon) {
        return fetch(REVERSE_URL + '?format=jsonv2&zoom=10&lat=' + lat.toFixed(4) + '&lon=' + lon.toFixed(4))
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function (data) {
                return labelFromAddress(data && data.address);
            });
    }

    function set(lat, lon, label) {
        current = { lat: lat, lon: lon, label: label || '' };
        save(current);
        emit();

        if (label) return;
        var target = current;
        reverseLabel(lat, lon)
            .then(function (name) {
                if (!name || current !== target) return;
                current.label = name;
                save(current);
                emit();
            })
            .catch(function (err) {
                console.warn('[location] reverse geocode failed:', err);
            });
    }

    function detect() {
        return new Promise(function (resolve, reject) {
            if (!navigator.geolocation) {
                reject(new Error('Geolocation unavailable'));
                return;
            }
            navigator.geolocation.getCurrentPosition(function (pos) {
                set(pos.coords.latitude, pos.coords.longitude);
                resolve(current);
            }, reject, { timeout: 15000, maximumAge: 5 * 60 * 1000 });
        });
    }

    global.LVLocation = {
        get: function () { return current; },
        set: set,
        detect: detect,
        labelFromAddress: labelFromAddress,
        subscribe: function (cb) {
            listeners.push(cb);
            if (current) cb(current);
        }
    };
})(window);
