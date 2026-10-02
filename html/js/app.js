var LVR_API_SOURCES = {
    local: 'http://localhost:8080',
    public: 'https://api.librewxr.net'
};
var LVR_API_FIXED = null;

var LeafletAdapter = function () {
    var map = null;
    var lvTileErrors = 0;
    var maxZoom = 12;

    var BASEMAPS = {
        'osm-standard': {
            url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
            attribution: '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> contributors',
            maxZoom: 19
        },
        'osm-humanitarian': {
            url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
            attribution: '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> contributors <a href="https://www.hotosm.org/">Humanitarian OSM Team</a>',
            maxZoom: 20
        },
        'cyclosm': {
            url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
            attribution: '<a href="https://github.com/cyclosm/cyclosm-cartocss-style/releases">CyclOSM</a> | <a href="https://openstreetmap.org">OpenStreetMap</a> contributors',
            maxZoom: 20
        },
        'opentopomap': {
            url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
            attribution: '<a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
            maxZoom: 17
        },
        'osm-dark': {
            url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            attribution: '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> contributors',
            maxZoom: 19,
            dark: true
        }
    };
    var AUTO_BASEMAPS = {
        dark: BASEMAPS['osm-dark'],
        light: BASEMAPS['osm-standard']
    };
    var basemapChoice = 'auto';
    var currentBaseMap = null;
    var alertLayers = [];
    var alertClickCb = null;
    var locationPin = null;
    var PIN_SVG = '<svg viewBox="0 0 28 40" aria-hidden="true">' +
        '<path class="lv-pin-body" d="M14 1.5C7.1 1.5 1.5 7 1.5 13.9 1.5 23 14 38.5 14 38.5S26.5 23 26.5 13.9C26.5 7 20.9 1.5 14 1.5z"/>' +
        '<circle class="lv-pin-dot" cx="14" cy="14" r="4.5"/>' +
        '</svg>';

    function paneZ(name, fallback) {
        var val = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
        return isNaN(val) ? fallback : val;
    }

    return {
        onMapReady: function (cb) { cb(); },

        createMap: function (containerId, view) {
            maxZoom = view.maxZoom;
            map = L.map(containerId, { maxZoom: view.maxZoom, zoomControl: true })
                .setView([view.lat, view.lon], view.zoom);

            map.createPane('lv-satellite-pane');
            map.getPane('lv-satellite-pane').style.zIndex = paneZ('--leaflet-z-satellite', 350);
            map.createPane('lv-alerts-pane');
            map.getPane('lv-alerts-pane').style.zIndex = paneZ('--leaflet-z-alerts', 400);
            map.createPane('lv-radar-pane');
            map.getPane('lv-radar-pane').style.zIndex = paneZ('--leaflet-z-radar', 450);
            return map;
        },

        setBasemap: function (theme) {
            if (currentBaseMap) map.removeLayer(currentBaseMap);
            var entry = (basemapChoice !== 'auto' && BASEMAPS[basemapChoice])
                || AUTO_BASEMAPS[theme]
                || AUTO_BASEMAPS.dark;

            map.getContainer().classList.toggle('lv-basemap-dark', !!entry.dark);
            currentBaseMap = L.tileLayer(entry.url, {
                attribution: entry.attribution,
                maxNativeZoom: entry.maxZoom || 19,
                maxZoom: 19
            });
            currentBaseMap.addTo(map);
            currentBaseMap.bringToBack();
        },

        setBasemapChoice: function (id) {
            if (id === 'auto' || BASEMAPS[id]) basemapChoice = id;
        },

        createFrameLayer: function (url, kind) {
            var pane = kind === 'satellite' ? 'lv-satellite-pane' : 'lv-radar-pane';
            var layer = new L.TileLayer(url, {
                tileSize: 256,
                opacity: 0,
                maxZoom: maxZoom,
                pane: pane
            });
            layer.createTile = function (coords, done) {
                var tile = document.createElement('img');

                tile.className = kind === 'satellite' ? 'satellite-tile' : 'radar-tile';
                tile.alt = '';
                var key = coords.x + ':' + coords.y + ':' + coords.z;
                var aborted = false;
                var onLoad = function () {
                    tile.removeEventListener('load', onLoad);
                    tile.removeEventListener('error', onError);
                    if (aborted) return;
                    tile.style.width = '256px';
                    tile.style.height = '256px';

                    if (!layer._tiles || !layer._tiles[key]) return;
                    if (done) done(null, tile);
                    layer.off('remove', abortTile);
                };
                var onError = function () {
                    tile.removeEventListener('load', onLoad);
                    tile.removeEventListener('error', onError);
                    if (aborted) return;

                    console.warn('[librewxr] tile load failed:', url);
                    lvTileErrors++;
                    if (!layer._tiles || !layer._tiles[key]) return;
                    if (done) done(new Error('Tile load failed'), tile);
                    layer.off('remove', abortTile);
                };
                var abortTile = function () {
                    aborted = true;
                    layer.off('remove', abortTile);

                    tile.removeAttribute('src');
                    tile.removeEventListener('load', onLoad);
                    tile.removeEventListener('error', onError);
                };
                layer.on('remove', abortTile);
                tile.addEventListener('load', onLoad);
                tile.addEventListener('error', onError);
                var url = this.getTileUrl(coords);
                tile.src = url;
                return tile;
            };

            layer.addTo(map);
            return layer;
        },

        onLayerReady: function (handle, cb) {
            var settled = false;
            var waiter = setTimeout(finish, 25000);

            function finish() {
                if (settled) return;
                settled = true;
                clearTimeout(waiter);
                handle.off('load', finish);
                handle.off('tileerror', finish);
                setTimeout(cb, 0);
            }
            handle.on('load', finish);
            handle.on('tileerror', finish);

            handle.on('tileerror', function (e) {
                var failedUrl = (e && e.tile && e.tile.src) ? e.tile.src : handle._url;
                console.warn('[librewxr] tile load failed:', failedUrl);
            });
        },

        setFrameOpacity: function (handle, v) {
            handle.setOpacity(v);
        },

        destroyFrameLayer: function (handle) {
            if (handle && map && map.hasLayer(handle)) map.removeLayer(handle);
        },

        onAlertClick: function (cb) { alertClickCb = cb; },

        setAlertsOverlay: function (geojsonOrNull, styleFn, reopenId) {
            if (alertLayers && alertLayers.length) {
                for (var i = 0; i < alertLayers.length; i++) map.removeLayer(alertLayers[i]);
                alertLayers = [];
            }
            if (!geojsonOrNull || !geojsonOrNull.features) return;

            var features = geojsonOrNull.features.slice();
            var sevOrder = { emergency: 5, extreme: 4, severe: 3, moderate: 2, minor: 1 };
            features.sort(function (a, b) {
                var sa = sevOrder[(a.properties && a.properties.severity || '').toLowerCase()] || 0;
                var sb = sevOrder[(b.properties && b.properties.severity || '').toLowerCase()] || 0;
                return sa - sb;
            });

            var pathsByUri = {};
            for (var i = 0; i < features.length; i++) {
                var feature = features[i];

                if (!feature.geometry) continue;
                var sev = (feature.properties && feature.properties.severity || 'unknown').toLowerCase();
                var zIdx = sevOrder[sev] ? sevOrder[sev] * 200 + 200 : 300;
                var fc = { type: 'FeatureCollection', features: [feature] };
                var layer = L.geoJSON(fc, {
                    pane: 'lv-alerts-pane',
                    style: function (f) { return styleFn(f); },
                    onEachFeature: function (f, lyr) {
                        if (f.properties && f.properties.__popup) {
                            lyr.bindPopup(f.properties.__popup, {
                                maxWidth: 320,
                                autoPan: true,
                                autoPanPadding: [20, 20],
                                closeOnClick: true
                            });
                        }

                        lyr.on('click', function (e) {
                            L.DomEvent.stopPropagation(e);
                            if (alertClickCb) {
                                alertClickCb(f.properties && (f.properties.uri || f.properties.title));
                            }
                        });
                        if (f.properties && f.properties.uri) {
                            pathsByUri[f.properties.uri] = lyr;
                        }
                    }
                });
                layer.setZIndex(zIdx);
                layer.addTo(map);
                alertLayers.push(layer);
            }

            if (reopenId && pathsByUri[reopenId]) {
                var reopenPath = pathsByUri[reopenId];
                setTimeout(function () {
                    try {
                        if (reopenPath._map) reopenPath.openPopup();
                    } catch (e) {  }
                }, 0);
            }
        },

        setLocationPin: function (lat, lon) {
            if (locationPin) {
                locationPin.setLatLng([lat, lon]);
                return;
            }
            locationPin = L.marker([lat, lon], {
                icon: L.divIcon({ className: 'lv-pin', html: PIN_SVG, iconSize: [28, 40], iconAnchor: [14, 39] }),
                interactive: false,
                keyboard: false
            }).addTo(map);
        },

        flyTo: function (lat, lon, zoom) {
            map.flyTo([lat, lon], zoom);
        },

        onViewportChange: function (cb) {
            map.on('moveend', cb);
        },

        getBounds: function () {
            var b = map.getBounds();
            return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
        }
    };
};

var LVR_OPACITY_KEY = 'librewxr.radarOpacity';

function lvrLoadOpacity() {
    try {
        var v = parseFloat(localStorage.getItem(LVR_OPACITY_KEY));
        return isNaN(v) ? 0.8 : v;
    } catch (e) {
        return 0.8;
    }
}

var adapter = new LeafletAdapter();
var lvrHome = LVLocation.get();
LibreWXR.createViewer({
    apiSources: LVR_API_SOURCES,
    apiFixed: LVR_API_FIXED,
    apiDefault: 'public',
    view: { lat: lvrHome ? lvrHome.lat : 39.8283, lon: lvrHome ? lvrHome.lon : -98.5795, zoom: 10, maxZoom: 12 },
    nowMarker: true,
    nowMarkerLabel: true,
    radarOpacity: lvrLoadOpacity(),
    onRadarOpacityChange: function (v) {
        try {
            localStorage.setItem(LVR_OPACITY_KEY, String(v));
        } catch (e) {}
    },
    onLocate: function (lat, lon) {
        LVLocation.set(lat, lon);
    }
}, adapter);

LVLocation.subscribe(function (loc) {
    adapter.setLocationPin(loc.lat, loc.lon);
});
if (!lvrHome) {
    LVLocation.detect()
        .then(function (loc) { adapter.flyTo(loc.lat, loc.lon, 10); })
        .catch(function (err) { console.warn('[location] detect failed:', err && err.message); });
}

(function () {
    var sel = document.getElementById('lv-basemap');
    if (!sel) return;
    sel.addEventListener('change', function () {
        adapter.setBasemapChoice(this.value);
        adapter.setBasemap(document.body.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
    });
})();
