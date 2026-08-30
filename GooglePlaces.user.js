// ==UserScript==
// @name         WME BRW Google Places
// @namespace    BeRoWaz
// @version      2026.08.30
// @author       BeRoWaz
// @description  Shows nearby Google Places next to the selected venue in the WME place editor
// @match        https://*.waze.com/editor*
// @match        https://*.waze.com/*/editor*
// @exclude      https://*.waze.com/user/editor*
// @exclude      https://*.waze.com/*/user/editor*
// @require      https://greasyfork.org/scripts/24851-wazewrap/code/WazeWrap.js
// @grant        none
// @run-at       document-idle
// @downloadURL  https://github.com/Thynamelessone/WME-Google-Places/raw/refs/heads/main/GooglePlaces.user.js
// @updateURL    https://github.com/Thynamelessone/WME-Google-Places/raw/refs/heads/main/GooglePlaces.user.js
// ==/UserScript==
(function () {
    "use strict";
    const updateMessage = ""
    WazeWrap.Interface.ShowScriptUpdate('WME BRW Google Places', GM_info.script.version, updateMessage);
    const SCRIPT_ID = "wme-brw-google-places";
    const SCRIPT_NAME = "WME BRW Google Places";
    const GOOGLE_PLACES_RESULT_COUNT = 10;
    const GOOGLE_PLACES_TYPE = "point_of_interest";
    const WME_DOM = {
        editPanel: "#edit-panel"
    };
    const BOX_ID = "wazept-google-places-box";
    const STATUS_ID = "wazept-google-places-status";
    const WAZE_CHANGE_HINT = "This usually means Waze changed something in the editor's code.";
    /** @type {any} */
    let sdk = null;
    const warnedOnce = new Set();
    function colorWithAlpha(rgbString, alpha) {
        const match = rgbString && rgbString.match(/rgba?\(([^)]+)\)/);
        if (!match) return null;
        const parts = match[1].split(",").map((s) => parseFloat(s));
        const [r, g, b] = parts;
        if ([r, g, b].some((n) => Number.isNaN(n))) return null;
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    function getReferenceStyle() {
        const candidates = [
            ".external-providers-control .section-title",
            ".external-providers-control .control-title",
            ".external-providers-control h3",
            ".external-providers-control .title",
            ".external-providers-control wz-label",
            ".external-providers-control",
            WME_DOM.editPanel
        ];
        for (const sel of candidates) {
            const node = document.querySelector(sel);
            if (node) {
                const style = getComputedStyle(node);
                if (style && style.color) return style;
            }
        }
        return null;
    }
    function getColors() {
        const ref = getReferenceStyle();
        const text = ref ? ref.color : null;
        return {
            text: text || "inherit",
            fontFamily: ref ? ref.fontFamily : "inherit",
            fontSize: ref ? ref.fontSize : "12px",
            border: colorWithAlpha(text, 0.35) || "rgba(128,128,128,0.4)",
            errorText: text || "inherit",
            errorBorder: "rgba(217,83,79,0.6)",
            errorHintText: text || "inherit",
            emptyText: text || "inherit"
        };
    }
    function warnOnce(key, message) {
        if (warnedOnce.has(key)) return;
        warnedOnce.add(key);
        console.warn(`[${SCRIPT_NAME}] ${message}`);
    }
    /** Show (or update) a one-line status message under the results box, e.g. after a failed "+" click. */
    function setStatus(message) {
        const box = document.getElementById(BOX_ID);
        if (!box) return;
        const colors = getColors();
        let status = box.querySelector(`#${STATUS_ID}`);
        if (!message) {
            status?.remove();
            return;
        }
        if (!status) {
            status = el("div", {
                id: STATUS_ID,
                style: `font-size:11px;color:${colors.errorText};margin-top:4px;`
            });
            box.appendChild(status);
        }
        status.textContent = message;
    }
    /** Renders a small red notice inside the results box explaining that something didn't populate. */
    function errorNotice(message) {
        const colors = getColors();
        return el("div", {
            style: `font-size:12px;color:${colors.errorText};border:1px solid ${colors.errorBorder};border-left:3px solid ${colors.errorBorder};border-radius:3px;padding:4px 6px;margin-top:5px;`
        }, [
            el("div", { text: `${SCRIPT_NAME}: ${message}` }),
            el("div", { text: WAZE_CHANGE_HINT, style: `font-size:11px;color:${colors.errorHintText};margin-top:2px;` })
        ]);
    }
    function emptyNotice(message) {
        const colors = getColors();
        return el("div", {
            style: `font-size:12px;color:${colors.emptyText};margin-top:5px;`,
            text: message
        });
    }
    function el(tag, props = {}, children = []) {
        const node = document.createElement(tag);
        Object.entries(props).forEach(([k, v]) => {
            if (k === "style") node.style.cssText = v;
            else if (k === "text") node.textContent = v;
            else if (k === "html") node.innerHTML = v;
            else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
            else node.setAttribute(k, v);
        });
        (Array.isArray(children) ? children : [children]).forEach((c) => c && node.appendChild(c));
        return node;
    }
    function getSelectedVenueId() {
        const selection = sdk.Editing.getSelection();
        if (!selection || selection.objectType !== "venue" || !selection.ids.length) return null;
        return String(selection.ids[0]);
    }
    function getSelectedVenue() {
        const venueId = getSelectedVenueId();
        if (!venueId) return null;
        return sdk.DataModel.Venues.getById({ venueId });
    }
    function geometryCenter(geometry) {
        if (geometry.type === "Point") {
            return { lon: geometry.coordinates[0], lat: geometry.coordinates[1] };
        }
        const ring = geometry.coordinates[0] || [];
        if (!ring.length) return null;
        const sum = ring.reduce((acc, c) => ({ lon: acc.lon + c[0], lat: acc.lat + c[1] }), { lon: 0, lat: 0 });
        return { lon: sum.lon / ring.length, lat: sum.lat / ring.length };
    }
    function haversineMeters(a, b) {
        const R = 6371000;
        const toRad = (d) => (d * Math.PI) / 180;
        const dLat = toRad(b.lat - a.lat);
        const dLon = toRad(b.lon - a.lon);
        const lat1 = toRad(a.lat);
        const lat2 = toRad(b.lat);
        const h =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
        return Math.round(R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
    }
    function nearbySearch(request) {
        return new Promise((resolve) => {
            if (typeof google === "undefined" || !google.maps?.places) {
                resolve([]);
                return;
            }
            const service = new google.maps.places.PlacesService(document.createElement("div"));
            service.nearbySearch(request, (results, status) => {
                if (status === google.maps.places.PlacesServiceStatus.OK && results) resolve(results);
                else resolve([]);
            });
        });
    }
    function addExternalProvider(name, vicinity) {
        setStatus(null);
        const addNew = document.querySelector(".external-providers-control .external-provider-add-new");
        if (!addNew) {
            const msg = 'Could not add this place ó the "Add external provider" control was not found.';
            warnOnce("external-provider-ui", msg);
            setStatus(`${msg} ${WAZE_CHANGE_HINT}`);
            return;
        }
        const rowSelector = ".external-providers-control > wz-list.external-providers-list > wz-list-item.external-provider-edit";
        const before = new Set(document.querySelectorAll(rowSelector));
        addNew.focus();
        addNew.click();
        setTimeout(() => {
            const after = [...document.querySelectorAll(rowSelector)];
            const newRow = after.find((row) => !before.has(row)) || after[after.length - 1];
            if (!newRow) {
                const msg = "Could not add this place ó no new external-provider row appeared after clicking Add.";
                warnOnce("external-provider-row", msg);
                setStatus(`${msg} ${WAZE_CHANGE_HINT}`);
                return;
            }
            const input = newRow
                .querySelector("div.external-provider-edit-form > div.form-group > wz-autocomplete")
                ?.shadowRoot?.querySelector("#text-input");
            if (!input) {
                const msg = "Could not add this place ó the new row's text field was not found.";
                warnOnce("external-provider-input", msg);
                setStatus(`${msg} ${WAZE_CHANGE_HINT}`);
                return;
            }
            input.focus();
            input.value = `${name}, ${vicinity}`;
            input.dispatchEvent(new Event("input", { bubbles: true }));
        }, 250);
    }
    async function buildGooglePlacesExtras(venue) {
        if (typeof google === "undefined" || !google.maps?.places) {
            return {
                content: errorNotice("Google Places is unavailable (google.maps.places did not load).")
            };
        }
        const center = geometryCenter(venue.geometry);
        if (!center) {
            return {
                content: errorNotice("Could not read this venue's location to look up nearby places.")
            };
        }
        const request = {
            location: new google.maps.LatLng(center.lat, center.lon),
            rankBy: google.maps.places.RankBy.DISTANCE,
            type: GOOGLE_PLACES_TYPE
        };
        const results = (await nearbySearch(request)).slice(0, GOOGLE_PLACES_RESULT_COUNT);
        if (!results.length) {
            return { content: emptyNotice("No nearby Google Places found.") };
        }
        const colors = getColors();
        const table = el("table", {
            id: "wazept-google-places-table",
            style: `font-size:${colors.fontSize};font-family:${colors.fontFamily};color:${colors.text};border:1px solid ${colors.border};width:100%;margin-top:5px;border-collapse:collapse;`
        });
        table.appendChild(
            el("thead", {}, [
                el("tr", { style: `border-bottom:1px solid ${colors.border};` }, [
                    el("th", { text: "Google place", style: "text-align:left;padding:2px 4px;" }),
                    el("th", { text: "Distance", style: "padding:2px 4px;" }),
                    el("th", { text: "", style: "width:30px;" })
                ])
            ])
        );
        const body = el("tbody");
        results.forEach((place) => {
            const loc = place.geometry?.location;
            const dist = loc ? haversineMeters(center, { lat: loc.lat(), lon: loc.lng() }) : "";
            const button = el("button", {
                text: "+",
                style: `width:22px;height:18px;font-size:10px;line-height:1;border:1px solid ${colors.border};border-radius:3px;cursor:pointer;`,
                onclick: () => addExternalProvider(place.name, place.vicinity || "")
            });
            const nameCell = place.place_id
                ? el("a", {
                    text: place.name || "",
                    href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.name || "")}&query_place_id=${encodeURIComponent(place.place_id)}`,
                    target: "_blank",
                    rel: "noopener noreferrer",
                    style: "color:#1a73e8;text-decoration:underline;"
                })
                : el("span", { text: place.name || "" });
            body.appendChild(
                el("tr", { style: `border-bottom:1px solid ${colors.border};` }, [
                    el("td", { style: "padding:2px 4px;" }, [nameCell]),
                    el("td", { text: String(dist), style: "text-align:center;padding:2px 4px;" }),
                    el("td", { style: "text-align:center;" }, [button])
                ])
            );
        });
        table.appendChild(body);
        return { content: table };
    }
    function findAddGooglePlaceButton() {
        return (
            document.querySelector("wz-button.external-provider-add-new") ||
            document.querySelector(".external-provider-add-new")
        );
    }
    function waitForAddGooglePlaceButton(timeoutMs = 3000) {
        return new Promise((resolve) => {
            const immediate = findAddGooglePlaceButton();
            if (immediate) return resolve(immediate);
            const observer = new MutationObserver(() => {
                const btn = findAddGooglePlaceButton();
                if (btn) {
                    observer.disconnect();
                    resolve(btn);
                }
            });
            const root = document.querySelector(WME_DOM.editPanel) || document.body;
            observer.observe(root, { childList: true, subtree: true });
            setTimeout(() => {
                observer.disconnect();
                resolve(findAddGooglePlaceButton());
            }, timeoutMs);
        });
    }
    function findFallbackAnchor() {
        return (
            document.querySelector(".external-providers-control") ||
            document.querySelector(WME_DOM.editPanel)
        );
    }
    async function insertGooglePlacesTable(content) {
        document.getElementById(BOX_ID)?.remove();
        if (!content) return;
        const button = await waitForAddGooglePlaceButton();
        const anchor = button || findFallbackAnchor();
        if (!anchor) {
            warnOnce("add-google-place-anchor", 'Could not find anywhere in the editor panel to show results.');
            return;
        }
        const box = el("div", { id: BOX_ID });
        if (!button) {
            const msg = 'Could not find the "+ Add linked Google place" control, so results are shown here instead.';
            warnOnce("add-google-place-anchor", msg);
            box.appendChild(errorNotice(msg));
        }
        box.appendChild(content);
        if (button) {
            button.insertAdjacentElement("afterend", box);
        } else {
            anchor.insertAdjacentElement("afterend", box);
        }
    }
    async function renderEditorPanel() {
        const venue = getSelectedVenue();
        if (!venue) return;
        const googleExtras = await buildGooglePlacesExtras(venue);
        insertGooglePlacesTable(googleExtras?.content || null);
    }
    async function init() {
        sdk = window.getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME });
        if (!sdk.State.isReady()) {
            await sdk.Events.once({ eventName: "wme-ready" });
        }
        sdk.Events.on({
            eventName: "wme-feature-editor-opened",
            eventHandler: ({ featureType }) => {
                if (featureType === "venue") renderEditorPanel();
            }
        });
        sdk.Events.on({
            eventName: "wme-selection-changed",
            eventHandler: () => {
                if (!getSelectedVenueId()) {
                    document.getElementById(BOX_ID)?.remove();
                }
            }
        });
    }
    if (window.SDK_INITIALIZED) {
        window.SDK_INITIALIZED.then(init).catch((e) => console.error(`[${SCRIPT_NAME}]`, e));
    } else {
        document.addEventListener("DOMContentLoaded", () => {
            window.SDK_INITIALIZED.then(init).catch((e) => console.error(`[${SCRIPT_NAME}]`, e));
        });
    }
})();