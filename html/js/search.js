(function () {
    var GEOCODER_URL = 'https://nominatim.openstreetmap.org/search';
    var MAX_ZOOM = 12;

    var form = document.getElementById('lv-search');
    var input = document.getElementById('lv-search-input');
    if (!form || !input) return;

    function zoomFor(box) {
        if (!box) return 10;
        var span = Math.max(Math.abs(box[1] - box[0]), Math.abs(box[3] - box[2]));
        if (span > 20) return 4;
        if (span > 8) return 5;
        if (span > 3) return 7;
        if (span > 1) return 8;
        if (span > 0.3) return 10;
        return 11;
    }

    var locate = document.getElementById('lv-locate');
    if (locate) {
        locate.addEventListener('click', function () {
            input.value = '';
            input.title = '';
            form.classList.remove('error');
        });
    }

    function fail(message) {
        form.classList.add('error');
        input.title = message;
    }

    form.addEventListener('submit', function (e) {
        e.preventDefault();
        var query = input.value.trim();
        if (!query || form.classList.contains('busy')) return;

        form.classList.remove('error');
        form.classList.add('busy');
        input.title = '';

        fetch(GEOCODER_URL + '?format=jsonv2&addressdetails=1&limit=1&q=' + encodeURIComponent(query))
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function (results) {
                if (!results.length) {
                    fail('No match found');
                    return;
                }
                var hit = results[0];
                var box = hit.boundingbox ? hit.boundingbox.map(parseFloat) : null;
                var lat = parseFloat(hit.lat);
                var lon = parseFloat(hit.lon);
                adapter.flyTo(lat, lon, Math.min(zoomFor(box), MAX_ZOOM));
                LVLocation.set(lat, lon, LVLocation.labelFromAddress(hit.address) || hit.name || query);
                input.blur();
            })
            .catch(function (err) {
                fail('Search failed: ' + err.message);
            })
            .then(function () {
                form.classList.remove('busy');
            });
    });
})();
