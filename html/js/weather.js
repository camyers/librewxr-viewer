(function () {
    if (typeof adapter === 'undefined' || !adapter.onMapClick) return;

    var API_URL = 'https://api.open-meteo.com/v1/forecast';
    var CACHE_MS = 10 * 60 * 1000;
    var TIMEOUT_MS = 10000;
    var STORAGE_KEY = 'librewxr.units';
    var HOURLY_STEP = 3;
    var HOURLY_COUNT = 6;
    var DAY_COUNT = 3;

    var UNIT_SETS = {
        imperial: {
            api: { temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch' },
            temp: '°F', wind: 'mph', precip: 'in', precipDigits: 2, hour12: true,
            pressure: function (hpa) { return (hpa / 33.8639).toFixed(2) + ' inHg'; }
        },
        metric: {
            api: { temperature_unit: 'celsius', wind_speed_unit: 'kmh', precipitation_unit: 'mm' },
            temp: '°C', wind: 'km/h', precip: 'mm', precipDigits: 1, hour12: false,
            pressure: function (hpa) { return Math.round(hpa) + ' hPa'; }
        }
    };

    var WEATHER_CODES = {
        0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
        45: 'Fog', 48: 'Rime fog',
        51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
        56: 'Light freezing drizzle', 57: 'Freezing drizzle',
        61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
        66: 'Light freezing rain', 67: 'Freezing rain',
        71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
        80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
        85: 'Light snow showers', 86: 'Snow showers',
        95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, heavy hail'
    };
    var COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

    var cache = {};
    var requestId = 0;
    var last = null;
    var units = loadUnits();

    function loadUnits() {
        try {
            var v = localStorage.getItem(STORAGE_KEY);
            return UNIT_SETS[v] ? v : 'imperial';
        } catch (e) {
            return 'imperial';
        }
    }

    function saveUnits(v) {
        try {
            localStorage.setItem(STORAGE_KEY, v);
        } catch (e) {}
    }

    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
        });
    }

    function wrapLon(lon) {
        return ((lon + 180) % 360 + 360) % 360 - 180;
    }

    function num(v, digits) {
        return typeof v === 'number' && isFinite(v) ? v.toFixed(digits || 0) : '--';
    }

    function describe(code) {
        return WEATHER_CODES[code] || 'Unknown';
    }

    function compass(deg) {
        if (typeof deg !== 'number') return '';
        return COMPASS[Math.round(deg / 22.5) % 16];
    }

    function hourLabel(iso, hour12) {
        var h = parseInt(iso.slice(11, 13), 10);
        if (!hour12) return (h < 10 ? '0' : '') + h + ':00';
        return (h % 12 || 12) + ' ' + (h < 12 ? 'AM' : 'PM');
    }

    function dayLabel(iso, index) {
        if (index === 0) return 'Today';
        var d = new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
        return d.toLocaleDateString(undefined, { weekday: 'short' });
    }

    function buildUrl(lat, lon) {
        var params = {
            latitude: lat.toFixed(4),
            longitude: lon.toFixed(4),
            current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl',
            hourly: 'temperature_2m,precipitation_probability,weather_code',
            daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum',
            timezone: 'auto',
            forecast_days: DAY_COUNT
        };
        var api = UNIT_SETS[units].api;
        for (var k in api) params[k] = api[k];
        return API_URL + '?' + Object.keys(params).map(function (key) {
            return key + '=' + encodeURIComponent(params[key]);
        }).join('&');
    }

    function fetchWeather(lat, lon) {
        var key = lat.toFixed(2) + ',' + lon.toFixed(2) + ',' + units;
        var hit = cache[key];
        if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.data);

        var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
        return fetch(buildUrl(lat, lon), ctrl ? { signal: ctrl.signal } : undefined)
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function (data) {
                if (!data || !data.current) throw new Error('Unexpected response');
                cache[key] = { at: Date.now(), data: data };
                return data;
            })
            .then(function (data) {
                if (timer) clearTimeout(timer);
                return data;
            }, function (err) {
                if (timer) clearTimeout(timer);
                throw (err && err.name === 'AbortError') ? new Error('Request timed out') : err;
            });
    }

    function renderHours(data, u) {
        var h = data.hourly;
        if (!h || !h.time) return '';
        var start = 0;
        while (start < h.time.length && h.time[start] <= data.current.time) start++;

        var cells = '';
        for (var n = 0; n < HOURLY_COUNT; n++) {
            var i = start + n * HOURLY_STEP;
            if (i >= h.time.length) break;
            cells += '<div class="lv-wx-hour">' +
                '<span class="lv-wx-hour-time">' + esc(hourLabel(h.time[i], u.hour12)) + '</span>' +
                '<span class="lv-wx-hour-temp">' + num(h.temperature_2m[i]) + '°</span>' +
                '<span class="lv-wx-hour-pop">' + num(h.precipitation_probability[i]) + '%</span>' +
                '</div>';
        }
        return cells ? '<div class="lv-wx-title">Next hours</div><div class="lv-wx-hours">' + cells + '</div>' : '';
    }

    function renderDays(data, u) {
        var d = data.daily;
        if (!d || !d.time) return '';
        var rows = '';
        for (var i = 0; i < d.time.length && i < DAY_COUNT; i++) {
            rows += '<div class="lv-wx-day">' +
                '<span class="lv-wx-day-name">' + esc(dayLabel(d.time[i], i)) + '</span>' +
                '<span class="lv-wx-day-desc">' + esc(describe(d.weather_code[i])) + '</span>' +
                '<span class="lv-wx-day-temp">' + num(d.temperature_2m_max[i]) + '° / ' + num(d.temperature_2m_min[i]) + '°</span>' +
                '<span class="lv-wx-day-pop">' + num(d.precipitation_probability_max[i]) + '%</span>' +
                '</div>';
        }
        return rows ? '<div class="lv-wx-title">Forecast</div><div class="lv-wx-days">' + rows + '</div>' : '';
    }

    function render(data) {
        var u = UNIT_SETS[units];
        var c = data.current;
        var wind = num(c.wind_speed_10m) + ' ' + u.wind + ' ' + compass(c.wind_direction_10m);
        if (typeof c.wind_gusts_10m === 'number') wind += ', gusts ' + num(c.wind_gusts_10m);

        return '<div class="lv-wx">' +
            '<div class="lv-wx-head">' +
                '<span class="lv-wx-temp">' + num(c.temperature_2m) + u.temp + '</span>' +
                '<span class="lv-wx-desc">' + esc(describe(c.weather_code)) + '</span>' +
            '</div>' +
            '<div class="lv-wx-sub">Feels like ' + num(c.apparent_temperature) + u.temp + '</div>' +
            '<dl class="lv-wx-grid">' +
                '<dt>Wind</dt><dd>' + esc(wind.trim()) + '</dd>' +
                '<dt>Precipitation</dt><dd>' + num(c.precipitation, u.precipDigits) + ' ' + u.precip + '</dd>' +
                '<dt>Humidity</dt><dd>' + num(c.relative_humidity_2m) + '%</dd>' +
                '<dt>Pressure</dt><dd>' + (typeof c.pressure_msl === 'number' ? u.pressure(c.pressure_msl) : '--') + '</dd>' +
            '</dl>' +
            renderHours(data, u) +
            renderDays(data, u) +
            '<div class="lv-wx-credit">Weather data by <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a></div>' +
            '</div>';
    }

    function message(text) {
        return '<div class="lv-wx"><div class="lv-wx-sub">' + esc(text) + '</div></div>';
    }

    function show(lat, lon, reopen) {
        var token = ++requestId;
        last = { lat: lat, lon: lon };
        if (reopen) adapter.openPopup(lat, lon, message('Loading weather...'));

        fetchWeather(lat, wrapLon(lon))
            .then(function (data) {
                if (token === requestId) adapter.setPopupContent(render(data));
            })
            .catch(function (err) {
                console.warn('[weather] request failed:', err);
                if (token === requestId) adapter.setPopupContent(message('Weather unavailable: ' + err.message));
            });
    }

    adapter.onMapClick(function (lat, lon) {
        show(lat, lon, true);
    });

    var select = document.getElementById('lv-units');
    if (select) {
        select.value = units;
        select.addEventListener('change', function () {
            if (!UNIT_SETS[this.value]) return;
            units = this.value;
            saveUnits(units);
            if (last && adapter.isPopupOpen()) show(last.lat, last.lon, false);
        });
    }
})();
