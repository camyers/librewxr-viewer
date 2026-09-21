(function (global) {
    'use strict';

    var DEFAULTS = {
        mapContainerId: 'lv-map',
        view: { lat: 39.8283, lon: -98.5795, zoom: 10, maxZoom: 12 },
        apiSources: {
            local: 'http://localhost:8080',
            public: 'https://api.librewxr.net'
        },
        apiFixed: null,
        layerMode: 'radar',
        colorScheme: 10,
        arrows: '',
        cells: '',
        smooth: true,
        snow: true,
        format: 'webp',
        tileSize: 'auto',
        theme: 'dark',
        alerts: false,
        alertsFileWarning: false,
        autoplay: false,
        nowMarker: false,
        nowMarkerLabel: true,
        alertsFillAlpha: null,
        refreshMs: 5 * 60 * 1000,
        strings: null,
        locale: null,
        hour12: null,
        onThemeChange: null,
        locateMode: null
    };

    var RADAR_OPACITY = 0.8;
    var SATELLITE_OPACITY = 0.8;
    var RADAR_ANIMATION_DELAY = 500;
    var RADAR_ANIMATION_PAUSE = 1500;
    var SAT_ANIMATION_DELAY = 800;
    var SAT_ANIMATION_PAUSE = 2000;
    var PRELOAD_CONCURRENCY = 3;
    var ALERTS_DEBOUNCE_MS = 800;
    var ALERTS_THROTTLE_MS = 3000;
    var RETRY_DELAYS = [5000, 15000, 30000];
    var NOW_MARKER_TICK_MS = 30000;

    function createViewer(userConfig, adapter) {
        var config = {};
        for (var dk in DEFAULTS) config[dk] = DEFAULTS[dk];
        if (userConfig) {
            for (var uk in userConfig) config[uk] = userConfig[uk];
        }

        function tr(key, fallback) {
            return (config.strings && config.strings[key]) || fallback;
        }

        var state = {
            apiData: null,
            mapFrames: [],
            nowcastStartIndex: -1,
            animationPosition: 0,
            animTimer: null,
            isPlaying: false,
            resumeOnVisible: false,
            autoplayPending: !!(config.autoplay && !prefersReducedMotion()),
            currentHandle: null,
            cache: {},
            satBgHandle: null,
            satBgTimestamp: null,
            colorScheme: config.colorScheme,
            arrows: config.arrows,
            cells: config.cells,
            smooth: config.smooth,
            snow: config.snow,
            format: config.format,
            tileSize: config.tileSize,
            layerMode: config.layerMode,
            theme: config.theme,
            alertsEnabled: config.alerts,
            alertsEpoch: 0,
            alertsDebounce: null,
            alertsCachedGlobal: null,
            alertsLastFetchTime: 0,
            alertsLastFilterTime: 0,
            alertsInFlight: false,
            lastClickedAlertId: null,
            alertsSkipNextViewport: false,
            sourceDefault: 'public',
            preloadEpoch: 0,
            preloadIndicatorVisible: false,
            singleLoads: 0,
            isDragging: false,
            refreshTimer: null,
            nowMarkerEl: null,
            nowMarkerTimer: null,
            nowMarkerLabelEl: null,
            refreshInFlight: false,
            retryAttempt: 0,
            lastCatalogLoad: 0,
            mapReady: false,
            booted: false,
            scrubberThumb: null,
            scrubberRailPast: null,
            scrubberRailDivider: null,
            scrubberRailNowcast: null
        };

        function byId(id) {
            return document.getElementById(id);
        }

        function cssVar(name, fallback) {
            var val = getComputedStyle(document.documentElement).getPropertyValue(name);
            val = val ? val.trim() : '';
            return val || fallback;
        }

        function escapeHtml(s) {
            return String(s).replace(/[&<>"']/g, function (ch) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
            });
        }

        function prefersReducedMotion() {
            return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        }

        function detectSourceDefault() {
            var loc = window.location;
            var isLocal = loc.protocol === 'file:' || loc.hostname === 'localhost' || loc.hostname === '127.0.0.1';
            return isLocal ? 'local' : 'public';
        }

        function apiBase() {
            if (config.apiFixed) return config.apiFixed;
            var c = byId('lv-source');
            if (c) {
                return config.apiSources[c.value] || config.apiSources[state.sourceDefault] || config.apiSources.public;
            }
            return config.apiSources[state.sourceDefault] || config.apiSources.public;
        }

        function catalogUrl() {
            return apiBase() + '/public/weather-maps.json';
        }

        function buildFrameLists() {
            state.mapFrames = [];
            state.nowcastStartIndex = -1;
            var data = state.apiData;
            if (!data || !data.radar) return;
            if (state.layerMode === 'satellite') {
                if (data.satellite && data.satellite.infrared && data.satellite.infrared.length > 0) {
                    state.mapFrames = data.satellite.infrared.slice();
                }
            } else {
                if (data.radar.past && data.radar.past.length > 0) {
                    state.mapFrames = data.radar.past.slice();
                    if (data.radar.nowcast && data.radar.nowcast.length > 0) {
                        state.nowcastStartIndex = state.mapFrames.length;
                        state.mapFrames = state.mapFrames.concat(data.radar.nowcast);
                    }
                }
            }
        }

        function noDataMessage() {
            if (!state.apiData || !state.apiData.radar) return tr('noData', 'No data');
            if (state.layerMode === 'satellite') return tr('noSatData', 'No satellite data');
            return tr('noRadarData', 'No radar data');
        }

        function frameKind() {
            return state.layerMode === 'satellite' ? 'satellite' : 'radar';
        }

        function resolveTileSize() {
            if (state.tileSize === 'auto') {
                return (window.devicePixelRatio && window.devicePixelRatio >= 1.5) ? 512 : 256;
            }
            return parseInt(state.tileSize, 10) || 256;
        }

        function buildTileUrl(frame) {
            var size = resolveTileSize();
            if (frameKind() === 'satellite') {
                return apiBase() + frame.path + '/' + size + '/{z}/{x}/{y}/0/0_0.' + state.format;
            }

            var url = apiBase() + frame.path + '/' + size + '/{z}/{x}/{y}/' + state.colorScheme +
                '/' + (state.smooth ? 1 : 0) + '_' + (state.snow ? 1 : 0) + '.' + state.format;
            var params = [];
            if (state.arrows) params.push('arrows=' + state.arrows);
            if (state.cells) params.push('cells=' + state.cells);
            if (params.length) url += '?' + params.join('&');
            return url;
        }

        function buildSatelliteUrl(frame) {
            return apiBase() + frame.path + '/' + resolveTileSize() + '/{z}/{x}/{y}/0/0_0.' + state.format;
        }

        function destroyCacheEntry(path) {
            var entry = state.cache[path];
            if (!entry) return;
            delete state.cache[path];
            if (entry.handle) adapter.destroyFrameLayer(entry.handle);
        }

        function clearAllFrameLayers() {
            for (var path in state.cache) destroyCacheEntry(path);
            state.currentHandle = null;
            removeSatelliteBackground();
        }

        function invalidateFrameLayers() {
            stopAnimation();
            clearAllFrameLayers();
            if (state.mapFrames.length === 0) return;
            updateSatelliteBackground();
            showFrame(state.animationPosition);
        }

        function removeSatelliteBackground() {
            if (state.satBgHandle) {
                adapter.destroyFrameLayer(state.satBgHandle);
                state.satBgHandle = null;
            }
            state.satBgTimestamp = null;
        }

        function updateSatelliteBackground() {
            if (state.layerMode !== 'both') {
                removeSatelliteBackground();
                return;
            }
            if (!state.apiData || !state.apiData.satellite || !state.apiData.satellite.infrared ||
                state.apiData.satellite.infrared.length === 0) return;
            var latest = state.apiData.satellite.infrared[state.apiData.satellite.infrared.length - 1];
            if (state.satBgTimestamp === latest.time) return;
            removeSatelliteBackground();
            var handle = adapter.createFrameLayer(buildSatelliteUrl(latest), 'satellite');
            state.satBgHandle = handle;
            state.satBgTimestamp = latest.time;
            adapter.setFrameOpacity(handle, SATELLITE_OPACITY);
        }

        function clampPosition(position) {
            if (state.mapFrames.length === 0) return 0;
            while (position >= state.mapFrames.length) position -= state.mapFrames.length;
            while (position < 0) position += state.mapFrames.length;
            return position;
        }

        function formatTime(timestamp) {
            return new Date(timestamp * 1000).toLocaleTimeString(config.locale || [], {
                hour: 'numeric',
                minute: '2-digit',
                hour12: config.hour12 === null ? undefined : config.hour12
            });
        }

        function isNowcastFrame(position) {
            return state.nowcastStartIndex >= 0 && position >= state.nowcastStartIndex;
        }

        function getFrameDelay(position) {
            if (state.nowcastStartIndex >= 0 && position === state.nowcastStartIndex - 1) return pauseDelay();
            if (position === state.mapFrames.length - 1) return pauseDelay();
            return frameDelay();
        }

        function frameDelay() {
            return state.layerMode === 'satellite' ? SAT_ANIMATION_DELAY : RADAR_ANIMATION_DELAY;
        }

        function pauseDelay() {
            return state.layerMode === 'satellite' ? SAT_ANIMATION_PAUSE : RADAR_ANIMATION_PAUSE;
        }

        function setTimestampText(text) {
            var el = byId('lv-timestamp');
            if (el) el.textContent = text;
        }

        function updateTimestamp(frame, position) {
            var el = byId('lv-timestamp');
            if (!el) return;
            var timeStr = formatTime(frame.time);

            var labelCls = isNowcastFrame(position) ? 'forecast-label' : 'forecast-label forecast-label--off';
            el.innerHTML = timeStr + '<span class="' + labelCls + '">' + tr('forecast', 'Forecast') + '</span>';
        }

        function showFrame(position) {
            if (state.mapFrames.length === 0) return;
            position = clampPosition(position);
            var frame = state.mapFrames[position];
            var kind = frameKind();
            var targetOpacity = (kind === 'satellite') ? SATELLITE_OPACITY : RADAR_OPACITY;

            state.animationPosition = position;
            updateTimestamp(frame, position);
            updateScrubberPosition();

            var entry = state.cache[frame.path];
            if (entry && entry.settled) {
                crossFade(entry.handle, targetOpacity);
                scheduleNext(position);
                return;
            }

            var createdEntry = false;
            if (!entry) {
                entry = state.cache[frame.path] = {
                    handle: adapter.createFrameLayer(buildTileUrl(frame), kind),
                    kind: kind,
                    settled: false
                };
                createdEntry = true;
                showSingleLoadIndicator();
            }

            var handle = entry.handle;
            adapter.onLayerReady(handle, function () {
                if (createdEntry) {
                    createdEntry = false;
                    hideSingleLoadIndicator();
                }
                var cur = state.cache[frame.path];
                if (!cur) {
                    if (state.currentHandle === handle) {
                        cur = state.cache[frame.path] = { handle: handle, kind: kind, settled: false };
                    } else {
                        adapter.destroyFrameLayer(handle);
                        return;
                    }
                }
                if (state.animationPosition === position) {
                    crossFade(handle, targetOpacity);
                    scheduleNext(position);
                } else {
                    adapter.setFrameOpacity(handle, 0);
                }
                if (!cur.settled) {
                    cur.settled = true;
                }
            });
        }

        function crossFade(handle, opacity) {
            var old = state.currentHandle;
            if (old && old !== handle) adapter.setFrameOpacity(old, 0);
            adapter.setFrameOpacity(handle, opacity);
            state.currentHandle = handle;
        }

        function scheduleNext(position) {
            if (!state.isPlaying) return;
            state.animTimer = setTimeout(function () {
                state.animTimer = null;
                showFrame(position + 1);
            }, getFrameDelay(position));
        }

        function setPlaying(on) {
            state.isPlaying = on;
            var playIcon = byId('lv-play-icon');
            var pauseIcon = byId('lv-pause-icon');
            if (playIcon) playIcon.style.display = on ? 'none' : '';
            if (pauseIcon) pauseIcon.style.display = on ? '' : 'none';
            var playBtn = byId('lv-play');
            if (playBtn) playBtn.setAttribute('aria-label', on ? 'Pause playback' : 'Play playback');
        }

        function stopAnimation() {
            if (state.animTimer) {
                clearTimeout(state.animTimer);
                state.animTimer = null;
            }
            cancelPreload();
            if (state.isPlaying) setPlaying(false);
        }

        function playStop() {
            if (state.isPlaying) {
                stopAnimation();
                var resetPos = state.nowcastStartIndex >= 0 ? state.nowcastStartIndex - 1 : state.mapFrames.length - 1;
                showFrame(resetPos);
            } else {
                if (state.mapFrames.length === 0) return;
                setPlaying(true);

                preloadFrames(state.animationPosition, {
                    showIndicator: true,
                    onComplete: function () {
                        if (state.isPlaying && state.animTimer == null) {
                            showFrame(state.animationPosition + 1);
                        }
                    }
                });
            }
        }

        function cancelPreload() {
            state.preloadEpoch++;
            hidePreloadIndicator();
        }

        function buildPreloadOrder(from, total) {
            var order = [];
            for (var d = 0; d < total; d++) {
                if (from + d < total) order.push(from + d);
                if (d > 0 && from - d >= 0) order.push(from - d);
            }
            return order;
        }

        function preloadFrames(fromPosition, opts) {
            opts = opts || {};
            cancelPreload();
            var epoch = state.preloadEpoch;
            if (state.mapFrames.length === 0) {
                if (opts.onComplete) opts.onComplete();
                return;
            }

            var toLoad = [];
            var order = buildPreloadOrder(fromPosition, state.mapFrames.length);
            for (var i = 0; i < order.length; i++) {
                var pos = order[i];
                var f = state.mapFrames[pos];
                var e = state.cache[f.path];
                if (!e || !e.settled) toLoad.push(pos);
            }
            if (toLoad.length === 0) {
                hidePreloadIndicator();
                if (opts.onComplete) opts.onComplete();
                return;
            }

            var total = toLoad.length;
            var done = 0;
            if (opts.showIndicator) showPreloadIndicator(0, total);

            function loadOne(pos, cb) {
                var frame = state.mapFrames[pos];
                var kind = frameKind();
                var existing = state.cache[frame.path];
                var handle;
                if (existing) {
                    handle = existing.handle;
                } else {
                    handle = adapter.createFrameLayer(buildTileUrl(frame), kind);
                    state.cache[frame.path] = { handle: handle, kind: kind, settled: false };
                }
                adapter.onLayerReady(handle, function () {
                    var entry = state.cache[frame.path];
                    if (epoch !== state.preloadEpoch) {
                        return;
                    }
                    if (entry) entry.settled = true;
                    cb();
                });
            }

            var idx = 0;
            function pump() {
                if (epoch !== state.preloadEpoch) return;
                if (idx >= toLoad.length) return;
                var pos = toLoad[idx++];
                loadOne(pos, function () {
                    if (epoch !== state.preloadEpoch) return;
                    done++;
                    if (opts.showIndicator) showPreloadIndicator(done, total);
                    if (done >= total) {
                        hidePreloadIndicator();
                        if (opts.onComplete) opts.onComplete();
                    } else {
                        pump();
                    }
                });
            }

            var workers = Math.min(PRELOAD_CONCURRENCY, toLoad.length);
            for (var w = 0; w < workers; w++) pump();
        }

        function restartBackgroundPreload() {
            if (!state.mapReady || state.mapFrames.length === 0) return;
            cancelPreload();
            preloadFrames(state.animationPosition, {
                showIndicator: false,
                onComplete: function () {
                    if (state.isPlaying && state.animTimer == null) {
                        showFrame(state.animationPosition + 1);
                    }
                }
            });
        }

        function setPreloadFill(pct) {
            var fill = byId('lv-preload-fill');
            if (fill) fill.style.width = pct + '%';
        }

        function showSingleLoadIndicator() {
            state.singleLoads++;
            if (state.preloadIndicatorVisible) return;
            var el = byId('lv-preload');
            if (!el) return;
            byId('lv-preload-text').textContent = tr('loadingFrame', 'Loading frame...');
            setPreloadFill(0);
            el.classList.add('visible');
        }

        function hideSingleLoadIndicator() {
            state.singleLoads = Math.max(0, state.singleLoads - 1);
            if (state.singleLoads > 0 || state.preloadIndicatorVisible) return;
            var el = byId('lv-preload');
            if (el) el.classList.remove('visible');
        }

        function showPreloadIndicator(done, total) {
            state.preloadIndicatorVisible = true;
            var el = byId('lv-preload');
            if (!el) return;
            byId('lv-preload-text').textContent = tr('loadingFrames', 'Loading frames ') + done + '/' + total;
            setPreloadFill(total > 0 ? (done / total) * 100 : 0);
            el.classList.add('visible');
        }

        function hidePreloadIndicator() {
            state.preloadIndicatorVisible = false;
            var el = byId('lv-preload');
            if (el) el.classList.remove('visible');
        }

        function buildScrubber() {
            var track = byId('lv-scrubber-track');
            var ticks = byId('lv-scrubber-ticks');
            if (!track || !ticks) return;
            track.innerHTML = '';
            ticks.innerHTML = '';

            var total = state.mapFrames.length;
            if (total === 0) {
                track.removeAttribute('role');
                track.removeAttribute('tabindex');
                track.removeAttribute('aria-valuemin');
                track.removeAttribute('aria-valuemax');
                track.removeAttribute('aria-valuenow');
                track.removeAttribute('aria-valuetext');
                return;
            }

            var rail = document.createElement('div');
            rail.className = 'scrubber-rail';
            var railPast = document.createElement('div');
            railPast.className = 'rail-past';
            var railDivider = document.createElement('div');
            railDivider.className = 'rail-divider';
            var railNowcast = document.createElement('div');
            railNowcast.className = 'rail-nowcast';
            rail.appendChild(railPast);
            rail.appendChild(railDivider);
            rail.appendChild(railNowcast);
            track.appendChild(rail);

            var thumb = document.createElement('div');
            thumb.className = 'scrubber-thumb';
            track.appendChild(thumb);
            state.scrubberThumb = thumb;
            state.scrubberRailPast = railPast;
            state.scrubberRailDivider = railDivider;
            state.scrubberRailNowcast = railNowcast;

            state.nowMarkerEl = null;
            state.nowMarkerLabelEl = null;
            if (config.nowMarker) {
                var nowMarker = document.createElement('div');
                nowMarker.className = 'now-marker';
                track.appendChild(nowMarker);
                state.nowMarkerEl = nowMarker;
                if (config.nowMarkerLabel) {
                    var nowLabel = document.createElement('span');
                    nowLabel.className = 'now-marker-label';
                    track.appendChild(nowLabel);
                    state.nowMarkerLabelEl = nowLabel;
                }
                if (!state.nowMarkerTimer) {
                    state.nowMarkerTimer = setInterval(updateNowMarker, NOW_MARKER_TICK_MS);
                }
                updateNowMarker();
            }

            var step = 1;
            if (total > 20) step = 3;
            else if (total > 12) step = 2;

            var hasNowcast = state.nowcastStartIndex >= 0;
            var pastCount = hasNowcast ? state.nowcastStartIndex : total;

            var pastPct = hasNowcast
                ? (total > 1 ? (Math.max(0, pastCount - 1) / (total - 1)) * 100 : 0)
                : 100;
            railPast.style.width = pastPct + '%';
            railDivider.style.display = state.nowcastStartIndex >= 0 ? '' : 'none';
            railNowcast.style.display = state.nowcastStartIndex >= 0 ? '' : 'none';

            if (hasNowcast) {
                var nowIndex = pastCount - 1;
                var tickAtNow = nowIndex >= 0 && (nowIndex % step) === 0;
                if (!tickAtNow) {
                    var divEl = document.createElement('span');
                    divEl.className = 'tick-divider';
                    divEl.style.left = pastPct + '%';
                    divEl.textContent = '|';
                    ticks.appendChild(divEl);
                }
            }

            for (var i = 0; i < total; i += step) {
                var pct = (i / (total - 1)) * 100;
                var tick = document.createElement('span');
                tick.className = 'tick-label';
                if (isNowcastFrame(i)) tick.classList.add('nowcast-tick');
                tick.style.left = pct + '%';
                tick.textContent = formatTime(state.mapFrames[i].time);
                tick.setAttribute('data-index', i);
                ticks.appendChild(tick);
            }

            var lastShown = total - 1 - ((total - 1) % step);
            if (lastShown !== total - 1) {
                var lastTick = document.createElement('span');
                lastTick.className = 'tick-label';
                if (isNowcastFrame(total - 1)) lastTick.classList.add('nowcast-tick');
                lastTick.style.left = '100%';
                lastTick.textContent = formatTime(state.mapFrames[total - 1].time);
                lastTick.setAttribute('data-index', total - 1);
                ticks.appendChild(lastTick);
            }

            track.setAttribute('role', 'slider');
            track.setAttribute('tabindex', '0');
            track.setAttribute('aria-label', 'Radar frame scrubber');
            track.setAttribute('aria-valuemin', '0');
            track.setAttribute('aria-valuemax', String(total - 1));
            track.setAttribute('aria-valuenow', '0');
            track.setAttribute('aria-valuetext', formatTime(state.mapFrames[0].time));

            updateScrubberPosition();
        }

        function updateScrubberPosition() {
            var track = byId('lv-scrubber-track');
            if (!track || !state.scrubberThumb) return;
            if (state.mapFrames.length <= 1) {
                state.scrubberThumb.style.left = '0%';
            } else {
                var pct = (state.animationPosition / (state.mapFrames.length - 1)) * 100;
                state.scrubberThumb.style.left = pct + '%';
            }
            track.setAttribute('aria-valuenow', String(state.animationPosition));
            if (state.mapFrames[state.animationPosition]) {
                track.setAttribute('aria-valuetext', formatTime(state.mapFrames[state.animationPosition].time));
            }

            var ticksEl = byId('lv-scrubber-ticks');
            var ticks = ticksEl ? ticksEl.querySelectorAll('.tick-label') : [];
            for (var i = 0; i < ticks.length; i++) {
                var idx = parseInt(ticks[i].getAttribute('data-index'), 10);
                if (idx === state.animationPosition) ticks[i].classList.add('active-tick');
                else ticks[i].classList.remove('active-tick');
            }
        }

        function updateNowMarker() {
            var el = state.nowMarkerEl;
            if (!el) return;
            var frames = state.mapFrames;
            if (!frames || frames.length < 2) {
                el.style.display = 'none';
                if (state.nowMarkerLabelEl) state.nowMarkerLabelEl.style.display = 'none';
                return;
            }
            el.style.display = '';
            if (state.nowMarkerLabelEl) state.nowMarkerLabelEl.style.display = '';
            var nowSec = Date.now() / 1000;
            var total = frames.length;
            var pos;
            if (nowSec <= frames[0].time) {
                pos = 0;
            } else if (nowSec >= frames[total - 1].time) {
                pos = total - 1;
            } else {
                pos = total - 1;
                for (var i = 0; i < total - 1; i++) {
                    var t0 = frames[i].time;
                    var t1 = frames[i + 1].time;
                    if (nowSec >= t0 && nowSec < t1) {
                        pos = t1 > t0 ? i + (nowSec - t0) / (t1 - t0) : i;
                        break;
                    }
                }
            }
            var leftPct = (pos / (total - 1)) * 100;
            el.style.left = leftPct + '%';
            if (state.nowMarkerLabelEl) {
                state.nowMarkerLabelEl.style.left = leftPct + '%';
                state.nowMarkerLabelEl.textContent = formatTime(nowSec);
            }
        }

        function positionFromScrubber(clientX) {
            var track = byId('lv-scrubber-track');
            if (!track || state.mapFrames.length === 0) return 0;
            var rect = track.getBoundingClientRect();
            var pct = (clientX - rect.left) / rect.width;
            pct = Math.max(0, Math.min(1, pct));
            return Math.round(pct * (state.mapFrames.length - 1));
        }

        function wireScrubber() {
            var track = byId('lv-scrubber-track');
            if (!track) return;

            function onDragStart(e) {
                if (state.mapFrames.length === 0) return;
                e.preventDefault();
                state.isDragging = true;
                if (state.scrubberThumb) state.scrubberThumb.classList.add('dragging');
                stopAnimation();
                var clientX = e.touches ? e.touches[0].clientX : e.clientX;
                showFrame(positionFromScrubber(clientX));
            }
            function onDragMove(e) {
                if (!state.isDragging) return;
                e.preventDefault();
                var clientX = e.touches ? e.touches[0].clientX : e.clientX;
                showFrame(positionFromScrubber(clientX));
            }
            function onDragEnd() {
                if (!state.isDragging) return;
                state.isDragging = false;
                if (state.scrubberThumb) state.scrubberThumb.classList.remove('dragging');
            }

            track.addEventListener('mousedown', onDragStart);
            track.addEventListener('touchstart', onDragStart, { passive: false });
            document.addEventListener('mousemove', onDragMove);
            document.addEventListener('touchmove', onDragMove, { passive: false });
            document.addEventListener('mouseup', onDragEnd);
            document.addEventListener('touchend', onDragEnd);

            track.addEventListener('keydown', function (e) {
                if (state.mapFrames.length === 0) return;
                var pos = state.animationPosition;
                if (e.key === 'ArrowLeft') pos--;
                else if (e.key === 'ArrowRight') pos++;
                else if (e.key === 'Home') pos = 0;
                else if (e.key === 'End') pos = state.mapFrames.length - 1;
                else return;
                e.preventDefault();
                e.stopPropagation();
                stopAnimation();
                showFrame(pos);
            });
        }

        function setTheme(theme) {
            state.theme = theme;
            document.body.setAttribute('data-theme', theme);
            adapter.setBasemap(theme);
            if (config.onThemeChange) config.onThemeChange(theme);
            updateThemeButton();

            if (state.alertsEnabled) fetchAlerts(false, true);
        }

        function updateThemeButton() {
            var btn = byId('lv-theme');
            if (!btn) return;
            var dark = state.theme === 'dark';
            btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
            btn.setAttribute('title', dark ? 'Switch to light theme' : 'Switch to dark theme');
            var sun = byId('lv-theme-sun');
            var moon = byId('lv-theme-moon');
            if (sun) sun.style.display = dark ? '' : 'none';
            if (moon) moon.style.display = dark ? 'none' : '';
        }

        function setAlertsEnabled(on) {
            if (on && config.alertsFileWarning) {
                showError('Weather alerts require serving this page over HTTP or HTTPS. From file:// the browser blocks the web worker that renders alert polygons.', false);

                setTimeout(hideError, 6000);
                return;
            }
            console.log('LibreWXR alerts: setAlertsEnabled(' + on + '), mapReady=' + state.mapReady);
            state.alertsEnabled = on;
            updateAlertsButton();
            if (on) {
                fetchAlerts(true);
            } else {
                adapter.setAlertsOverlay(null);
            }
        }

        function updateAlertsButton() {
            var btn = byId('lv-alerts');
            if (!btn) return;
            btn.classList.toggle('active', state.alertsEnabled);
            btn.setAttribute('aria-pressed', state.alertsEnabled ? 'true' : 'false');
        }

        function fetchAlerts(force, bypassThrottle) {
            if (!state.alertsEnabled || !state.mapReady) {
                console.warn('LibreWXR alerts: fetch skipped (alertsEnabled=' + state.alertsEnabled + ', mapReady=' + state.mapReady + ')');
                return;
            }
            if (state.alertsInFlight) return;
            var now = Date.now();

            if (state.alertsCachedGlobal) {
                if (!force) {
                    if (!bypassThrottle && now - state.alertsLastFilterTime < ALERTS_THROTTLE_MS) return;
                    state.alertsLastFilterTime = now;
                    applyCachedAlerts();
                    return;
                }
                if (!bypassThrottle && now - state.alertsLastFetchTime < ALERTS_THROTTLE_MS) {
                    applyCachedAlerts();
                    return;
                }
            }

            state.alertsLastFetchTime = now;
            state.alertsInFlight = true;
            var epoch = ++state.alertsEpoch;

            var url = apiBase() + '/v2/alerts?simplify=1000';
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.onload = function () {
                state.alertsInFlight = false;
                if (epoch !== state.alertsEpoch || !state.alertsEnabled) return;
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        var parsed = JSON.parse(xhr.responseText);
                        state.alertsCachedGlobal = (parsed && parsed.features) ? parsed.features : [];
                        applyCachedAlerts();
                    } catch (e) {
                        console.warn('LibreWXR: failed to render alerts overlay', e);
                    }
                } else {
                    console.warn('LibreWXR alerts: unexpected status ' + xhr.status + ' - keeping previous overlay');
                }
            };
            xhr.onerror = function () {
                state.alertsInFlight = false;
                console.warn('LibreWXR alerts: network error - keeping previous overlay');
            };
            xhr.ontimeout = function () {
                state.alertsInFlight = false;
                console.warn('LibreWXR alerts: request timed out - keeping previous overlay');
            };
            xhr.onabort = function () {
                state.alertsInFlight = false;
                console.warn('LibreWXR alerts: request aborted - keeping previous overlay');
            };
            console.log('LibreWXR alerts: fetching', url);
            xhr.send();
        }

        function applyCachedAlerts() {
            var bounds = adapter.getBounds();
            var filtered = filterAlertsByBounds(state.alertsCachedGlobal, bounds);
            var fc = { type: 'FeatureCollection', features: filtered };
            adapter.setAlertsOverlay(decorateAlerts(fc), alertStyleFn, state.lastClickedAlertId);
        }

        function filterAlertsByBounds(features, viewport) {
            var out = [];
            for (var i = 0; i < features.length; i++) {
                var f = features[i];
                if (!f || !f.geometry) continue;
                var coords;
                if (f.geometry.type === 'Polygon') {
                    coords = f.geometry.coordinates[0];
                } else if (f.geometry.type === 'MultiPolygon') {
                    coords = [];
                    for (var j = 0; j < f.geometry.coordinates.length; j++) {
                        var ring = f.geometry.coordinates[j][0];
                        for (var k = 0; k < ring.length; k++) coords.push(ring[k]);
                    }
                } else {
                    continue;
                }
                if (!coords || coords.length === 0) continue;
                var minLon = Infinity, maxLon = -Infinity;
                var minLat = Infinity, maxLat = -Infinity;
                for (var m = 0; m < coords.length; m++) {
                    var lon = coords[m][0], lat = coords[m][1];
                    if (lon < minLon) minLon = lon;
                    if (lon > maxLon) maxLon = lon;
                    if (lat < minLat) minLat = lat;
                    if (lat > maxLat) maxLat = lat;
                }
                var outside = maxLon < viewport.west || minLon > viewport.east ||
                    maxLat < viewport.south || minLat > viewport.north;
                if (!outside) out.push(f);
            }
            return out;
        }

        function decorateAlerts(geojson) {
            if (!geojson || !geojson.features) return geojson;
            for (var i = 0; i < geojson.features.length; i++) {
                var f = geojson.features[i];
                var p = f.properties || (f.properties = {});
                p.__popup = alertPopupHtml(p);
            }
            return geojson;
        }

        function extractEventFromTitle(title) {
            if (!title) return '';
            var t = String(title);
            var idx = t.toLowerCase().indexOf(' issued ');
            return idx !== -1 ? t.substring(0, idx) : t;
        }

        function determineAlertSeverity(event, title, description) {
            var e = String(event || '').toLowerCase();
            var combined = (String(title || '') + ' ' + String(description || '')).toLowerCase();

            if (e.indexOf('extreme wind warning') >= 0 ||
                combined.indexOf('tornado emergency') >= 0 ||
                combined.indexOf('flash flood emergency') >= 0 ||
                combined.indexOf('particularly dangerous situation') >= 0) {
                return 'emergency';
            }
            if (e.indexOf('tornado warning') >= 0 ||
                e.indexOf('hurricane warning') >= 0 ||
                e.indexOf('flash flood warning') >= 0 ||
                e.indexOf('tsunami warning') >= 0 ||
                e.indexOf('storm surge warning') >= 0) {
                return 'extreme';
            }

            if (e.indexOf('freeze warning') >= 0) return 'moderate';
            if (e.indexOf('storm surge watch') >= 0) return 'severe';
            if (e.indexOf('special weather statement') >= 0 ||
                e.indexOf('hazardous weather outlook') >= 0 ||
                e.indexOf('air quality alert') >= 0 ||
                e.indexOf('hydrologic outlook') >= 0 ||
                e.indexOf('beach hazards statement') >= 0 ||
                e.indexOf('urban and small stream') >= 0 ||
                e.indexOf('lake wind advisory') >= 0 ||
                e.indexOf('short term forecast') >= 0 ||
                e.indexOf('advisory') >= 0 ||
                e.indexOf('statement') >= 0) {
                return 'minor';
            }
            if (e.indexOf('warning') >= 0) return 'severe';
            if (e.indexOf('watch') >= 0) return 'moderate';
            return 'moderate';
        }

        function deriveUrgency(event) {
            var e = String(event || '').toLowerCase();
            return e.indexOf('warning') >= 0 ? 'Immediate' : 'Expected';
        }

        function identifyAlertHazards(alertTitle, fullDescription) {
            var hazards = {};
            var combinedText = (String(alertTitle || '') + ' ' + String(fullDescription || '')).toLowerCase();

            var placeNamePatterns = [
                /\b(road|rd\.?|street|st\.?|ave\.?|avenue|ln\.?|lane|blvd\.?|boulevard|dr\.?|drive|way|place|pl\.?|parkway|pkwy\.?|highway|hwy\.?)\b/,
                /\b(city|town|county|village|district|neighborhood|park|plaza|center|square|region|area|zone)\b/,
                /\b(creek|river|lake|pond|bay|mountain|hill|valley|canyon|ridge|peak|summit|basin)\b/
            ];

            function isLikelyPlaceName(matchText, context) {
                context = context || 50;
                var m = String(matchText).toLowerCase();
                var matchIndex = combinedText.indexOf(m);
                if (matchIndex === -1) return false;
                var start = Math.max(0, matchIndex - context);
                var end = Math.min(combinedText.length, matchIndex + m.length + context);
                var surrounding = combinedText.substring(start, end);
                for (var i = 0; i < placeNamePatterns.length; i++) {
                    if (placeNamePatterns[i].test(surrounding)) return true;
                }
                return false;
            }

            var hazardPatterns = [
                { pattern: /\btornado\b/, type: 'tornado' },
                { pattern: /\bhail\b/, type: 'hail' },
                { pattern: /\bflash flood\b|\bflooding\b|\bflood\b/, type: 'flood' },
                { pattern: /\bthunder\b|\bthunderstorm\b|\bsevere thunderstorm\b/, type: 'thunderstorm' },
                { pattern: /\blightning\b/, type: 'lightning' },
                { pattern: /\bfire weather\b|\bred flag\b|\bwildfire\b|\bfire warning\b|\bextreme fire\b/, type: 'fire' },
                { pattern: /\bair quality\b|\bair stagnation\b|\bsmoke advisory\b|\bparticulate\b/, type: 'air-quality' },
                { pattern: /\bavalanche\b/, type: 'avalanche' },
                { pattern: /\bstorm surge\b|\bcoastal flood\b/, type: 'surge' },
                { pattern: /\btsunami\b/, type: 'tsunami' },
                { pattern: /\bsmall craft\b|\bgale warning\b|\bmarine warning\b|\bmarine weather\b|\bbeach hazard\b|\brip current\b|\bhigh surf\b/, type: 'marine' },
                { pattern: /\b(?:winter storm|winter weather|heavy snow|snowfall|snow accumulation|snow and ice|snow advisory|snow warning|snow emergency|snowstorm|snow covered|snow level)\b/, type: 'snow' },
                { pattern: /\bice storm\b|\bsleet\b|\bfreezing rain\b|\bfreezing drizzle\b|\bice pellets\b/, type: 'ice' },
                { pattern: /\bfreeze\b|\bfreezing\b|\bfrost\b|\bsub-freezing\b/, type: 'cold' },
                { pattern: /\bwind\b|\bgust\b|\bstrong winds\b/, type: 'wind' },
                { pattern: /\bdust\b/, type: 'dust' },
                { pattern: /\bsmoke\b/, type: 'smoke' },
                { pattern: /\bfog\b/, type: 'fog' },
                { pattern: /\bheat\b/, type: 'heat' },
                { pattern: /\bcold\b|\bchill\b|\bwind chill\b|\bhypothermia\b/, type: 'cold' },
                { pattern: /\brain\b|\bshower\b/, type: 'rain' },
                { pattern: /\b(?:hurricane warning|hurricane watch|hurricane advisory|hurricane threat|approaching hurricane|major hurricane|potential hurricane|category \d hurricane|hurricane force|tropical storm|tropical cyclone|tropical depression)\b/, type: 'hurricane' }
            ];

            for (var i = 0; i < hazardPatterns.length; i++) {
                var hp = hazardPatterns[i];
                if (hp.pattern.test(combinedText)) hazards[hp.type] = true;
            }

            if (!hazards.snow) {
                var snowMatches = combinedText.match(/\bsnow\b/g);
                if (snowMatches) {
                    var hasWeatherContext = /snow.{0,30}(weather|forecast|warning|advisory|inches|feet|heavy|condition|expect|potential|accumulation|amount|total|depth|fall|coverage)/.test(combinedText);
                    for (var s = 0; s < snowMatches.length; s++) {
                        if (hasWeatherContext && !isLikelyPlaceName(snowMatches[s])) {
                            hazards.snow = true;
                            break;
                        }
                    }
                }
                if (!hazards.snow && /\bblizzard\b/.test(combinedText) && !isLikelyPlaceName('blizzard')) {
                    hazards.snow = true;
                }
                if (!hazards.snow && /\bwinter\b/.test(combinedText) &&
                    /winter.{0,20}(weather|storm|advisory|warning)/.test(combinedText) &&
                    !isLikelyPlaceName('winter')) {
                    hazards.snow = true;
                }
            }

            if (!hazards.hurricane && /\bhurricane\b/.test(combinedText)) {
                var weatherContextMatch = /hurricane.{0,30}(warning|watch|advisory|category|mph|wind|storm|evacuat|weather|intensity|eye|cyclone|damage|impact|approach|strength)/.test(combinedText);
                if (weatherContextMatch && !isLikelyPlaceName('hurricane')) {
                    hazards.hurricane = true;
                }
            }

            return Object.keys(hazards);
        }

        function getPrimaryHazardType(eventType) {
            var title = String(eventType || '').toLowerCase();

            function isLikelyPlaceName(term) {
                var placePatterns = [
                    /(city|town|county|village|district|road|rd\.?|street|st\.?|avenue|ave\.?|lane|ln\.?|drive|dr\.?|way|blvd\.?|plaza|park)/,
                    /(creek|river|lake|pond|bay|mountain|hill|valley|canyon|ridge)/
                ];
                for (var i = 0; i < placePatterns.length; i++) {
                    if (new RegExp(term + '\\s+' + placePatterns[i].source, 'i').test(title)) return true;
                    if (new RegExp(placePatterns[i].source + '\\s+' + term, 'i').test(title)) return true;
                }
                return false;
            }

            if (/\btornado\b/.test(title)) return 'tornado';
            if (/\btsunami\b/.test(title)) return 'tsunami';
            if (/\bhurricane warning\b|\bhurricane watch\b|\btropical storm\b|\bcategory \d hurricane\b/.test(title)) return 'hurricane';
            if (/\bstorm surge\b|\bcoastal flood\b/.test(title)) return 'surge';
            if (/\bfire weather\b|\bred flag\b|\bwildfire\b|\bextreme fire\b/.test(title)) return 'fire';
            if (/\bair quality\b|\bair stagnation\b|\bsmoke advisory\b/.test(title)) return 'air-quality';
            if (/\bavalanche\b/.test(title)) return 'avalanche';
            if (/\bsmall craft\b|\bgale warning\b|\bmarine warning\b|\bmarine weather\b|\bbeach hazard\b|\brip current\b|\bhigh surf\b/.test(title)) return 'marine';
            if (/\bflash flood\b/.test(title)) return 'flood';
            if (/\bthunderstorm\b/.test(title)) return 'thunderstorm';
            if (/\blightning\b/.test(title)) return 'lightning';
            if (/\bflood\b/.test(title)) return 'flood';
            if (/\b(winter storm|winter weather|heavy snow|snowfall|snowstorm)\b/.test(title)) return 'snow';
            if (/\bsnow\b/.test(title) && !/\bsnow creek\b/.test(title) && !isLikelyPlaceName('snow')) return 'snow';
            if (/\bblizzard\b/.test(title) && !isLikelyPlaceName('blizzard')) return 'snow';
            if (/\bice\b|\bfreezing rain\b|\bfreezing drizzle\b|\bice storm\b/.test(title)) return 'ice';
            if (/\bfreeze\b|\bfreezing\b|\bfrost\b/.test(title)) return 'cold';
            if (/\bwind\b/.test(title)) return 'wind';
            if (/\bheat\b/.test(title)) return 'heat';
            if (/\bcold\b/.test(title)) return 'cold';
            if (/\bfog\b/.test(title)) return 'fog';
            if (/\bdust\b/.test(title)) return 'dust';
            if (/\bsmoke\b/.test(title)) return 'smoke';
            if (/\brain\b/.test(title)) return 'rain';
            if (/\bweather statement\b/.test(title)) return 'special-weather';

            if (/\bhurricane\b/.test(title) && !isLikelyPlaceName('hurricane')) return 'hurricane';

            var firstWord = title.split(' ')[0];
            return firstWord === 'watch' || firstWord === 'warning' || firstWord === 'advisory'
                ? (title.split(' ')[1] || 'unknown')
                : firstWord;
        }

        function alertStyleFn(feature) {
            var props = feature && feature.properties ? feature.properties : {};
            var headline = props.title || '';
            var event = extractEventFromTitle(headline);
            var severity = determineAlertSeverity(event, headline, props.description || '');

            if (severity === 'emergency') {
                return {
                    color: '#7B1FA2',
                    fillColor: '#7B1FA2',
                    fillOpacity: 0.4,
                    weight: 3.5,
                    opacity: 1,
                    className: 'emergency-alert-polygon'
                };
            }

            var intensity = severity === 'extreme' ? 3 : (severity === 'severe' ? 2 : (severity === 'minor' ? 0 : 1));
            var borderOpacity = 0.7 + intensity * 0.1;
            var fillOpacity = 0.15 + intensity * 0.05;

            var hazardType = getPrimaryHazardType(event);
            var palettes = {
                flood:          ['#81C784', '#66BB6A', '#4CAF50', '#2E7D32'],
                thunderstorm:   ['#FFD54F', '#FFC107', '#FF9800', '#F57C00'],
                'special-weather': ['#FFD54F', '#FFC107', '#FF9800', '#F57C00'],
                tornado:        ['#EF9A9A', '#EF5350', '#E53935', '#B71C1C'],
                dust:           ['#EF9A9A', '#EF5350', '#E53935', '#B71C1C'],
                snow:           ['#9FA8DA', '#7986CB', '#3F51B5', '#283593'],
                ice:            ['#9FA8DA', '#7986CB', '#3F51B5', '#283593'],
                fire:           ['#FFAB91', '#FF7043', '#F4511E', '#BF360C'],
                fog:            ['#B0BEC5', '#90A4AE', '#607D8B', '#37474F'],
                wind:           ['#80CBC4', '#4DB6AC', '#009688', '#00695C'],
                hurricane:      ['#80CBC4', '#4DB6AC', '#009688', '#00695C'],
                heat:           ['#FFAB91', '#FF7043', '#F4511E', '#BF360C'],
                cold:           ['#9FA8DA', '#7986CB', '#3F51B5', '#283593'],
                default:        ['#B39DDB', '#9575CD', '#673AB7', '#4527A0']
            };
            var palette = palettes[hazardType] || palettes['default'];
            var color = palette[intensity];

            var className = severity === 'extreme' ? 'extreme-alert-polygon'
                : (severity === 'severe' ? 'severe-alert-polygon' : '');

            return {
                color: color,
                fillColor: color,
                fillOpacity: config.alertsFillAlpha != null ? config.alertsFillAlpha : fillOpacity,
                weight: severity === 'extreme' ? 3 : (severity === 'severe' ? 2.5 : 2),
                opacity: borderOpacity,
                className: className
            };
        }

        function alertPopupHtml(p) {
            var headline = p.title || 'Weather Alert';
            var event = extractEventFromTitle(headline) || headline;
            var severity = determineAlertSeverity(event, headline, p.description || '');
            var urgency = deriveUrgency(event);
            var hazards = identifyAlertHazards(headline, p.description || '');
            var color = (alertStyleFn({ properties: p })).color;

            var isEmergency = severity === 'emergency';
            var isExtreme = severity === 'extreme';
            var isSevere = severity === 'severe';
            var pulseClass = isEmergency ? 'lv-popup-pulse-fast' : (isExtreme ? 'lv-popup-pulse-slow' : '');
            var emoji = (isEmergency || isExtreme) ? '\u26A0\uFE0F ' : '';

            var sevText = severity.toUpperCase();
            var sevClass = isEmergency ? 'emergency' : (isExtreme ? 'extreme' : (isSevere ? 'severe' : (severity === 'moderate' ? 'moderate' : 'minor')));

            var desc = (headline !== event && headline !== 'Weather Alert')
                ? '<p class="lv-alert-popup-description">' + escapeHtml(headline) + '</p>'
                : '';

            var expires = p.expires
                ? '<p class="lv-alert-popup-expires"><strong>Expires:</strong> ' + escapeHtml(formatAlertTime(p.expires)) + '</p>'
                : '';

            var hazardHtml = '';
            if (hazards.length > 0) {
                hazardHtml = '<div class="lv-alert-popup-hazards">' +
                    '<p class="lv-alert-popup-hazards-label"><strong>Hazards:</strong></p>' +
                    '<div class="lv-alert-popup-hazard-tags">';
                for (var i = 0; i < hazards.length; i++) {
                    hazardHtml += '<span class="lv-alert-popup-hazard-tag">' +
                        escapeHtml(hazards[i].charAt(0).toUpperCase() + hazards[i].slice(1)) + '</span>';
                }
                hazardHtml += '</div></div>';
            }

            var action = '';
            if (isEmergency) {
                action = '<p class="lv-alert-popup-action emergency"><strong>SEEK SHELTER NOW:</strong> This is an EMERGENCY. Take immediate life-saving action and follow official instructions.</p>';
            } else if (isExtreme) {
                action = '<p class="lv-alert-popup-action extreme"><strong>TAKE ACTION NOW:</strong> This is an EXTREME alert. Seek shelter or follow official instructions immediately.</p>';
            } else if (isSevere) {
                action = '<p class="lv-alert-popup-action severe"><strong>BE PREPARED:</strong> This is a SEVERE alert. Prepare to take action if in the affected area.</p>';
            } else if (severity === 'moderate') {
                action = '<p class="lv-alert-popup-action moderate"><strong>STAY AWARE:</strong> Monitor conditions and follow updates.</p>';
            }

            var fullText = p.description
                ? '<details><summary class="lv-alert-popup-summary">View Full Alert</summary>' +
                  '<div class="lv-alert-popup-fulltext">' + escapeHtml(p.description).replace(/\n/g, '<br>') + '</div></details>'
                : '';

            return '<div class="lv-alert-popup" style="--alert-color:' + color + '">' +
                '<h3 class="lv-alert-popup-title ' + pulseClass + '">' + emoji + escapeHtml(event) + (isEmergency || isExtreme ? ' \u26A0\uFE0F' : '') + '</h3>' +
                '<div class="lv-alert-popup-meta">' +
                '<span class="lv-alert-severity ' + sevClass + '">' + sevText + '</span>' +
                '<span class="lv-alert-popup-urgency">' + escapeHtml(urgency.toUpperCase()) + '</span>' +
                '</div>' +
                desc +
                expires +
                hazardHtml +
                action +
                fullText +
                '</div>';
        }

        function formatAlertTime(v) {
            var d = (typeof v === 'number') ? new Date(v * 1000) : new Date(v);
            if (isNaN(d.getTime())) return String(v);
            return d.toLocaleString((config.locale || undefined), {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                hour12: config.hour12 === null ? undefined : config.hour12
            });
        }

        function populateColorSchemes() {
            var select = byId('lv-scheme');
            if (!select) return;
            if (!state.apiData || !state.apiData.radar || !state.apiData.radar.colorSchemes) return;
            var schemes = state.apiData.radar.colorSchemes;
            var prev = state.colorScheme;
            select.innerHTML = '';
            for (var i = 0; i < schemes.length; i++) {
                var opt = document.createElement('option');
                opt.value = schemes[i].id;
                opt.textContent = schemes[i].name;
                if (schemes[i].id === prev) opt.selected = true;
                select.appendChild(opt);
            }
            var raw = document.createElement('option');
            raw.value = '255';
            raw.textContent = 'Raw (255)';
            if (prev === 255) raw.selected = true;
            select.appendChild(raw);
        }

        function updateRadarControlVisibility() {
            var isSatOnly = state.layerMode === 'satellite';
            var c;
            if ((c = byId('lv-scheme'))) c.style.display = isSatOnly ? 'none' : '';
            if ((c = byId('lv-arrows'))) c.style.display = isSatOnly ? 'none' : '';
            if ((c = byId('lv-cells'))) c.style.display = isSatOnly ? 'none' : '';
            document.dispatchEvent(new CustomEvent('lvselect:sync'));
        }

        function loadCatalog() {
            stopAnimation();
            setTimestampText(tr('loading', 'Loading...'));

            var xhr = new XMLHttpRequest();
            xhr.open('GET', catalogUrl(), true);
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        onCatalogSuccess(JSON.parse(xhr.responseText));
                    } catch (e) {
                        onCatalogError('Invalid catalog response');
                    }
                } else {
                    onCatalogError(tr('apiError', 'API error') + ' (HTTP ' + xhr.status + ')');
                }
            };
            xhr.onerror = function () {
                onCatalogError(tr('connFailed', 'Connection failed'));
            };
            xhr.send();
        }

        function onCatalogSuccess(data) {
            state.retryAttempt = 0;
            state.lastCatalogLoad = Date.now();
            hideError();
            hideRefreshStatus();
            state.apiData = data;
            reinitialize();
            if (state.autoplayPending) {
                state.autoplayPending = false;

                setTimeout(function () { playStop(); }, 800);
            }
        }

        function onCatalogError(msg) {
            if (state.retryAttempt < RETRY_DELAYS.length) {
                var delay = RETRY_DELAYS[state.retryAttempt++];
                showError(msg + ' - retrying in ' + Math.round(delay / 1000) + 's', false);
                setTimeout(function () { loadCatalog(); }, delay);
            } else {
                showError(msg + ' - check your connection and try again.', true);
            }
        }

        function reinitialize() {
            stopAnimation();
            clearAllFrameLayers();
            populateColorSchemes();
            buildFrameLists();
            state.animationPosition = 0;
            buildScrubber();

            if (state.mapFrames.length === 0) {
                if (state.layerMode === 'satellite') {
                    console.warn('[librewxr] satellite catalog section empty - no satellite frames to display');
                }
                setTimestampText(noDataMessage());
                return;
            }

            updateSatelliteBackground();

            var startPos;
            if (state.layerMode === 'satellite') {
                startPos = state.mapFrames.length - 1;
            } else {
                startPos = state.nowcastStartIndex >= 0 ? state.nowcastStartIndex - 1 : state.mapFrames.length - 1;
            }
            showFrame(startPos);
        }

        function sameTimeList(a, b) {
            if (!a || !b || a.length !== b.length) return false;
            for (var i = 0; i < a.length; i++) {
                if (a[i].time !== b[i].time) return false;
            }
            return true;
        }

        function sameSchemes(a, b) {
            var as = a && a.radar ? a.radar.colorSchemes : null;
            var bs = b && b.radar ? b.radar.colorSchemes : null;
            if (!as || !bs) return !as && !bs;
            if (as.length !== bs.length) return false;
            for (var i = 0; i < as.length; i++) {
                if (as[i].id !== bs[i].id) return false;
            }
            return true;
        }

        function findFrameIndex(path) {
            for (var i = 0; i < state.mapFrames.length; i++) {
                if (state.mapFrames[i].path === path) return i;
            }
            return -1;
        }

        function applyCatalogDiff(newData) {
            var savedData = state.apiData;
            var oldFrames = state.mapFrames;
            var oldNowcastStart = state.nowcastStartIndex;

            state.apiData = newData;
            buildFrameLists();
            var newFrames = state.mapFrames;

            var oldPaths = {};
            for (var i = 0; i < oldFrames.length; i++) oldPaths[oldFrames[i].path] = true;
            var newPaths = {};
            for (var j = 0; j < newFrames.length; j++) newPaths[newFrames[j].path] = true;
            var removed = [];
            for (var p in oldPaths) if (!newPaths[p]) removed.push(p);

            var satChanged = savedData && savedData.satellite && newData.satellite &&
                !sameTimeList(savedData.satellite.infrared || [], newData.satellite.infrared || []);
            var schemesChanged = !sameSchemes(savedData, newData);

            var orderChanged = false;
            if (oldFrames.length === newFrames.length) {
                for (var oi = 0; oi < oldFrames.length; oi++) {
                    if (oldFrames[oi].path !== newFrames[oi].path) {
                        orderChanged = true;
                        break;
                    }
                }
            }
            var framesChanged = removed.length > 0 || orderChanged ||
                (oldFrames.length !== newFrames.length) ||
                oldNowcastStart !== state.nowcastStartIndex;

            if (!framesChanged && !satChanged && !schemesChanged) {
                return;
            }

            var wasPlaying = state.isPlaying;
            if (wasPlaying) stopAnimation();

            for (var k = 0; k < removed.length; k++) destroyCacheEntry(removed[k]);

            populateColorSchemes();

            if (framesChanged) {
                var curPath = oldFrames[state.animationPosition] ? oldFrames[state.animationPosition].path : null;
                buildScrubber();

                var newPos = curPath != null ? findFrameIndex(curPath) : -1;
                if (newPos < 0) {
                    newPos = state.nowcastStartIndex >= 0 ? state.nowcastStartIndex - 1 : newFrames.length - 1;
                }
                showFrame(newPos);
            } else {
                showFrame(state.animationPosition);
            }

            updateSatelliteBackground();
            if (wasPlaying) playStop();
        }

        function startAutoRefresh() {
            if (state.refreshTimer) clearInterval(state.refreshTimer);
            state.refreshTimer = setInterval(refreshCatalog, config.refreshMs);
        }

        function refreshCatalog() {
            if (document.hidden || state.refreshInFlight) return;
            state.refreshInFlight = true;

            var xhr = new XMLHttpRequest();
            xhr.open('GET', catalogUrl(), true);
            xhr.onload = function () {
                state.refreshInFlight = false;
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        applyCatalogDiff(JSON.parse(xhr.responseText));
                        state.lastCatalogLoad = Date.now();
                        hideRefreshStatus();
                        if (state.alertsEnabled) fetchAlerts(true);
                    } catch (e) {
                        showRefreshStatus('Refresh failed - invalid response');
                    }
                } else {
                    showRefreshStatus('Refresh failed (HTTP ' + xhr.status + ') - retrying');
                    setTimeout(refreshCatalog, 15000);
                }
            };
            xhr.onerror = function () {
                state.refreshInFlight = false;
                showRefreshStatus('Refresh failed - connection error, retrying');
                setTimeout(refreshCatalog, 15000);
            };
            xhr.send();
        }

        function showRefreshStatus(msg) {
            var el = byId('lv-refresh-status');
            if (!el) return;
            el.textContent = msg;
            el.classList.add('visible');
        }

        function hideRefreshStatus() {
            var el = byId('lv-refresh-status');
            if (el) el.classList.remove('visible');
        }

        function showError(msg, showRetry) {
            var overlay = byId('lv-error');
            if (!overlay) return;
            var msgEl = byId('lv-error-msg');
            var retryBtn = byId('lv-error-retry');
            if (msgEl) msgEl.textContent = msg;
            if (retryBtn) retryBtn.style.display = showRetry ? '' : 'none';
            overlay.classList.add('visible');
        }

        function hideError() {
            var overlay = byId('lv-error');
            if (overlay) overlay.classList.remove('visible');
        }

        function applyLayerMode(mode) {
            if (mode !== 'radar' && mode !== 'satellite' && mode !== 'both') return;
            if (state.layerMode === mode) return;
            state.layerMode = mode;
            updateRadarControlVisibility();
            reinitialize();
        }

        function applyColorScheme(n) {
            n = parseInt(n, 10);
            if (isNaN(n) || n === state.colorScheme) return;
            state.colorScheme = n;
            invalidateFrameLayers();
        }

        function applyArrows(v) {
            v = v || '';
            if (v === state.arrows) return;
            state.arrows = v;
            invalidateFrameLayers();
        }

        function applyCells(v) {
            v = v || '';
            if (v === state.cells) return;
            state.cells = v;
            invalidateFrameLayers();
        }

        function applySmooth(b) {
            b = !!b;
            if (b === state.smooth) return;
            state.smooth = b;
            invalidateFrameLayers();
        }

        function applySnow(b) {
            b = !!b;
            if (b === state.snow) return;
            state.snow = b;
            invalidateFrameLayers();
        }

        function applyFormat(v) {
            v = v || 'webp';
            if (v === state.format) return;
            state.format = v;
            invalidateFrameLayers();
        }

        function applyTileSize(v) {
            v = v || 'auto';
            if (v === state.tileSize) return;
            state.tileSize = v;
            invalidateFrameLayers();
        }

        function wireControls() {
            var c;

            if ((c = byId('lv-source'))) {
                c.addEventListener('change', function () { loadCatalog(); });
            }
            if ((c = byId('lv-layermode'))) {
                c.addEventListener('change', function () {
                    applyLayerMode(this.value);
                });
            }
            if ((c = byId('lv-scheme'))) {
                c.addEventListener('change', function () {
                    applyColorScheme(this.value);
                });
            }
            if ((c = byId('lv-arrows'))) {
                c.addEventListener('change', function () {
                    applyArrows(this.value);
                });
            }
            if ((c = byId('lv-cells'))) {
                c.addEventListener('change', function () {
                    applyCells(this.value);
                });
            }
            if ((c = byId('lv-alerts'))) {
                c.addEventListener('click', function () {
                    console.log('LibreWXR alerts: button clicked, currently', state.alertsEnabled ? 'ON' : 'OFF');
                    setAlertsEnabled(!state.alertsEnabled);
                });
            }
            if ((c = byId('lv-theme'))) {
                c.addEventListener('click', function () {
                    setTheme(state.theme === 'dark' ? 'light' : 'dark');
                });
            }
            if ((c = byId('lv-locate'))) {
                c.addEventListener('click', onLocate);
            }
            if ((c = byId('lv-options-btn'))) {
                c.addEventListener('click', function () {
                    var panel = byId('lv-options');
                    if (!panel) return;
                    var open = panel.classList.toggle('open');
                    this.setAttribute('aria-expanded', open ? 'true' : 'false');
                });
            }
            if ((c = byId('lv-smooth'))) {
                c.addEventListener('change', function () {
                    applySmooth(this.checked);
                });
            }
            if ((c = byId('lv-snow'))) {
                c.addEventListener('change', function () {
                    applySnow(this.checked);
                });
            }
            if ((c = byId('lv-format'))) {
                c.addEventListener('change', function () {
                    applyFormat(this.value);
                });
            }
            if ((c = byId('lv-tilesize'))) {
                c.addEventListener('change', function () {
                    applyTileSize(this.value);
                });
            }
            if ((c = byId('lv-play'))) {
                c.addEventListener('click', playStop);
            }
            if ((c = byId('lv-error-retry'))) {
                c.addEventListener('click', function () {
                    hideError();
                    state.retryAttempt = 0;
                    loadCatalog();
                });
            }

            wireScrubber();
            wireKeyboard();
            wireVisibility();
        }

        function syncControlValues() {
            var c;
            if ((c = byId('lv-source'))) c.value = state.sourceDefault;
            if ((c = byId('lv-layermode'))) c.value = state.layerMode;
            if ((c = byId('lv-scheme'))) c.value = String(state.colorScheme);
            if ((c = byId('lv-arrows'))) c.value = state.arrows;
            if ((c = byId('lv-cells'))) c.value = state.cells;
            if ((c = byId('lv-smooth'))) c.checked = state.smooth;
            if ((c = byId('lv-snow'))) c.checked = state.snow;
            if ((c = byId('lv-format'))) c.value = state.format;
            if ((c = byId('lv-tilesize'))) c.value = state.tileSize;
            updateRadarControlVisibility();
            updateAlertsButton();
            updateThemeButton();
        }

        function onLocate() {
            if (config.locateMode === 'view') {
                adapter.flyTo(config.view.lat, config.view.lon, null);
                return;
            }
            if (!navigator.geolocation) return;
            navigator.geolocation.getCurrentPosition(function (pos) {
                adapter.flyTo(pos.coords.latitude, pos.coords.longitude, 10);
            }, function () {
            });
        }

        function wireKeyboard() {
            document.addEventListener('keydown', function (e) {
                var tag = e.target && e.target.tagName;
                if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
                if (e.key === ' ' || e.key === 'Spacebar') {
                    e.preventDefault();
                    playStop();
                } else if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    stopAnimation();
                    showFrame(state.animationPosition - 1);
                } else if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    stopAnimation();
                    showFrame(state.animationPosition + 1);
                }
            });
        }

        function wireVisibility() {
            document.addEventListener('visibilitychange', function () {
                if (document.hidden) {
                    if (state.isPlaying) {
                        state.resumeOnVisible = true;
                        stopAnimation();
                    }
                } else {
                    if (state.resumeOnVisible) {
                        state.resumeOnVisible = false;
                        playStop();
                    }

                    if (Date.now() - state.lastCatalogLoad > config.refreshMs) {
                        refreshCatalog();
                    }
                }
            });
        }

        function onViewportChange() {
            if (state.alertsSkipNextViewport) {
                state.alertsSkipNextViewport = false;
            } else {
                state.lastClickedAlertId = null;
                if (state.alertsEnabled) {
                    clearTimeout(state.alertsDebounce);
                    state.alertsDebounce = setTimeout(fetchAlerts, ALERTS_DEBOUNCE_MS);
                }
            }
            restartBackgroundPreload();
        }

        function boot() {
            if (state.booted) return;
            state.booted = true;
            adapter.setBasemap(state.theme);
            startAutoRefresh();
            if (state.alertsEnabled) fetchAlerts(true);
            loadCatalog();
        }

        function init() {
            state.sourceDefault = detectSourceDefault();
            syncControlValues();
            wireControls();
            document.body.setAttribute('data-theme', state.theme);

            var map = adapter.createMap(config.mapContainerId, config.view);
            state.map = map;
            state.mapReady = true;

            adapter.onViewportChange(onViewportChange);

            if (adapter.onAlertClick) {
                adapter.onAlertClick(function (id) {
                    state.lastClickedAlertId = id;
                    state.alertsSkipNextViewport = true;
                });
            }

            if (adapter.onMapReady) adapter.onMapReady(boot);
            else boot();
        }

        init();

        return {
            setLayerMode: applyLayerMode,
            setColorScheme: applyColorScheme,
            setArrows: applyArrows,
            setCells: applyCells,
            setSmooth: applySmooth,
            setSnow: applySnow,
            setFormat: applyFormat,
            setTileSize: applyTileSize,
            setAlertsEnabled: setAlertsEnabled,
            setTheme: setTheme
        };
    }

    global.LibreWXR = { createViewer: createViewer };
})(window);
