(function () {
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

    var ICONS = {
        temp: '<svg viewBox="0 0 24 24"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></svg>',
        wind: '<svg viewBox="0 0 24 24"><path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2"/></svg>',
        arrow: '<svg viewBox="0 0 24 24"><polygon points="12 2 19 21 12 17 5 21 12 2"/></svg>',
        precip: '<svg viewBox="0 0 24 24"><path d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25"/><line x1="8" y1="13" x2="8" y2="21"/><line x1="12" y1="15" x2="12" y2="23"/><line x1="16" y1="13" x2="16" y2="21"/></svg>',
        humidity: '<svg viewBox="0 0 24 24"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>',
        pressure: '<svg viewBox="0 0 24 24"><path d="M3.5 17a9 9 0 1 1 17 0"/><line x1="12" y1="15" x2="16" y2="9"/><circle cx="12" cy="15" r="1"/></svg>'
    };

    var button = document.getElementById('lv-weather-btn');
    var menu = document.getElementById('lv-weather-menu');
    var tempEl = document.getElementById('lv-weather-temp');
    if (!button || !menu || !tempEl) return;

    var cache = {};
    var requestId = 0;
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

    function cacheKey(loc) {
        return loc.lat.toFixed(2) + ',' + loc.lon.toFixed(2) + ',' + units;
    }

    function fresh(loc) {
        var hit = cache[cacheKey(loc)];
        return hit && Date.now() - hit.at < CACHE_MS ? hit.data : null;
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

    function fetchWeather(loc) {
        var hit = fresh(loc);
        if (hit) return Promise.resolve(hit);

        var key = cacheKey(loc);
        var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
        return fetch(buildUrl(loc.lat, wrapLon(loc.lon)), ctrl ? { signal: ctrl.signal } : undefined)
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

    function placeName(loc) {
        return loc.label || (loc.lat.toFixed(3) + ', ' + loc.lon.toFixed(3));
    }

    function header(loc) {
        return '<div class="settings-menu-title">Current conditions</div>' +
            '<div class="lv-wx-place">' + esc(loc ? placeName(loc) : 'No location set') + '</div>';
    }

    function row(icon, label, value, extra, iconStyle) {
        return '<div class="lv-wx-row">' +
            '<span class="lv-wx-icon"' + (iconStyle ? ' style="' + iconStyle + '"' : '') + '>' + icon + '</span>' +
            '<span class="lv-wx-label">' + label + '</span>' +
            '<span class="lv-wx-value">' + value + (extra ? '<span class="lv-wx-extra">' + extra + '</span>' : '') + '</span>' +
            '</div>';
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
            cells += '<div class="lv-wx-hour" title="' + esc(describe(h.weather_code[i])) + '">' +
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
            var amount = typeof d.precipitation_sum[i] === 'number' && d.precipitation_sum[i] > 0
                ? ', ' + num(d.precipitation_sum[i], u.precipDigits) + ' ' + u.precip : '';
            rows += '<div class="lv-wx-day">' +
                '<span class="lv-wx-day-name">' + esc(dayLabel(d.time[i], i)) + '</span>' +
                '<span class="lv-wx-day-desc">' + esc(describe(d.weather_code[i])) + '</span>' +
                '<span class="lv-wx-day-temp">' + num(d.temperature_2m_max[i]) + '° / ' + num(d.temperature_2m_min[i]) + '°</span>' +
                '<span class="lv-wx-day-pop" title="Chance of precipitation' + esc(amount) + '">' + num(d.precipitation_probability_max[i]) + '%</span>' +
                '</div>';
        }
        return rows ? '<div class="lv-wx-title">Forecast</div><div class="lv-wx-days">' + rows + '</div>' : '';
    }

    function render(loc, data) {
        var u = UNIT_SETS[units];
        var c = data.current;
        var dir = c.wind_direction_10m;
        var hasDir = typeof dir === 'number' && isFinite(dir);
        var gusts = typeof c.wind_gusts_10m === 'number' ? 'Gusts ' + num(c.wind_gusts_10m) + ' ' + u.wind : '';

        return header(loc) +
            '<div class="lv-wx-desc">' + esc(describe(c.weather_code)) + '</div>' +
            row(ICONS.temp, 'Temperature', num(c.temperature_2m) + u.temp,
                'Feels like ' + num(c.apparent_temperature) + '°') +
            row(ICONS.wind, 'Wind speed', num(c.wind_speed_10m) + ' ' + u.wind, gusts) +
            row(ICONS.arrow, 'Direction',
                hasDir ? 'From ' + compass(dir) : '--',
                hasDir ? Math.round(dir) + '°' : '',
                hasDir ? 'transform: rotate(' + ((dir + 180) % 360) + 'deg)' : '') +
            row(ICONS.precip, 'Precipitation', num(c.precipitation, u.precipDigits) + ' ' + u.precip, 'Last hour') +
            row(ICONS.humidity, 'Humidity', num(c.relative_humidity_2m) + '%') +
            row(ICONS.pressure, 'Pressure', typeof c.pressure_msl === 'number' ? u.pressure(c.pressure_msl) : '--') +
            renderHours(data, u) +
            renderDays(data, u) +
            '<div class="lv-wx-credit">Weather data by <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a></div>';
    }

    function message(loc, text) {
        return header(loc) + '<div class="lv-wx-sub">' + esc(text) + '</div>';
    }

    function setButton(text, title) {
        tempEl.textContent = text;
        button.title = title;
        button.setAttribute('aria-label', title);
    }

    function refresh(force) {
        var loc = LVLocation.get();
        var token = ++requestId;
        if (loc && force === true) delete cache[cacheKey(loc)];
        if (!loc) {
            setButton('--°', 'Current weather');
            menu.innerHTML = message(null, 'Search for a place or use Locate me to set your location.');
            return;
        }

        if (!fresh(loc)) menu.innerHTML = message(loc, 'Loading weather...');
        fetchWeather(loc)
            .then(function (data) {
                if (token !== requestId) return;
                var temp = num(data.current.temperature_2m) + '°';
                setButton(temp, 'Current weather at ' + placeName(loc) + ': ' + temp);
                menu.innerHTML = render(loc, data);
            })
            .catch(function (err) {
                console.warn('[weather] request failed:', err);
                if (token !== requestId) return;
                setButton('--°', 'Current weather unavailable');
                menu.innerHTML = message(loc, 'Weather unavailable: ' + err.message);
            });
    }

    function setOpen(open) {
        menu.hidden = !open;
        button.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) refresh();
    }

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

    setInterval(function () {
        if (!document.hidden) refresh(true);
    }, CACHE_MS);

    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) refresh();
    });

    var select = document.getElementById('lv-units');
    if (select) {
        select.value = units;
        select.addEventListener('change', function () {
            if (!UNIT_SETS[this.value]) return;
            units = this.value;
            saveUnits(units);
            refresh();
        });
    }

    LVLocation.subscribe(refresh);
    if (!LVLocation.get()) refresh();
})();
