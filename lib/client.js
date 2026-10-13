/**
 * dsh-turbo — web client half (v3: self-diagnosing).
 *
 * Adds a "Turbo" toggle to the composer tool row (the
 * `conversation.input.right` list slot, just before the send action).
 * The button reads and writes the host plugin's `enabled` Config field
 * through the settings controller's Remote namespace (`remote.settings`),
 * so the flip applies live: the host fiber re-runs apply() with the new
 * config and the speed tools/prompt section appear or disappear.
 *
 * `inject` lists every service the plugin touches, so the client runtime
 * pends this plugin until they are all active (a plain ctx.get at apply
 * time can lose the load-order race against the remote-namespaces mount).
 *
 * Diagnostics: the pill always shows its state — ✓ on, dimmed off, and an
 * inline error message when the settings bridge fails (synchronous proxy
 * throws included). Clicking the error retries the load.
 *
 * Hand-written in the DSH lazy-CJS bundle format; no build step.
 */
window.__ModuleLoader__.load({
	id: "dsh-turbo",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");

		/** Services this plugin touches — the fiber starts once all are active. */
		var inject = ["slots", "locale", "remote.settings"];

		/** Button dictionaries, keyed by locale namespace. */
		var DICTS = {
			en: {
				label: "Turbo",
				onHint: "Turbo is ON — read_many / workspace_map tools and batching guidance are active. Click to disable.",
				offHint: "Turbo is OFF — click to enable the agent speed pack.",
				errorHint: "Turbo bridge error (click to retry)",
			},
			ru: {
				label: "Турбо",
				onHint: "Турбо включён — инструменты read_many / workspace_map и подсказки активны. Нажмите, чтобы выключить.",
				offHint: "Турбо выключен — нажмите, чтобы включить пакет ускорения агента.",
				errorHint: "Турбо: ошибка связи (нажмите, чтобы повторить)",
			},
			zh: {
				label: "Turbo",
				onHint: "Turbo 已开启 — read_many / workspace_map 工具与批处理提示已启用。点击关闭。",
				offHint: "Turbo 已关闭 — 点击启用代理加速包。",
				errorHint: "Turbo 连接错误（点击重试）",
			},
		};

		/** Unwrap the {ok, value} envelope that the Remote gateway returns. */
		function unwrapRemote(result) {
			if (result && typeof result === "object" && typeof result.value !== "undefined" && result.ok === true) return result.value;
			return result;
		}

		/** Extract the namespaces array from a settings describe() result,
		 * tolerating both {namespaces: [...]} and {ok, value: {namespaces: [...]}} shapes. */
		function getNamespaces(answer) {
			var inner = unwrapRemote(answer);
			if (inner && typeof inner === "object" && Array.isArray(inner.namespaces)) return inner.namespaces;
			if (Array.isArray(inner)) return inner;
			return undefined;
		}

		/** Find this plugin's namespace view in a settings describe() answer. */
		function findTurboNamespace(answer) {
			var namespaces = getNamespaces(answer);
			if (!Array.isArray(namespaces)) return undefined;
			return namespaces.find(function (view) {
				var ns = String(view && view.ns);
				return ns === "turbo" || ns.indexOf("turbo") !== -1;
			});
		}

		/** Compact list of namespace ids for diagnostics. */
		function namespaceIds(answer) {
			var namespaces = getNamespaces(answer);
			if (!Array.isArray(namespaces)) return "(no namespaces; raw=" + JSON.stringify(answer).slice(0, 120) + ")";
			return namespaces.map(function (view) { return String(view && view.ns); }).join(", ");
		}

		/** Read the effective `enabled` flag; absent means the schema default. */
		function readEnabled(view) {
			var value = view && view.value;
			if (value && typeof value.enabled === "boolean") return value.enabled;
			return true;
		}

		function messageOf(error) {
			if (error == null) return "unknown error";
			if (typeof error === "string") return error;
			return String(error.message || error.code || error);
		}

		var BASE_STYLE = {
			display: "inline-flex",
			alignItems: "center",
			gap: "4px",
			font: "inherit",
			fontSize: "12px",
			lineHeight: "16px",
			padding: "2px 8px",
			borderRadius: "999px",
			cursor: "pointer",
			color: "inherit",
			whiteSpace: "nowrap",
			maxWidth: "280px",
			overflow: "hidden",
			textOverflow: "ellipsis",
		};

		function apply(ctx) {
			var slots = ctx.get("slots");
			var locale = ctx.get("locale");
			var settings = ctx.get("remote.settings");
			if (!slots) return;
			if (locale) {
				ctx.effect(function () {
					return locale.register("turbo", DICTS);
				}, "turbo: dictionaries");
			}
			var t = locale ? locale.bind("turbo") : function (key) { return (DICTS.en[key] || key); };

			function TurboButton() {
				var pair = React.useState({ phase: "loading", enabled: true, revision: undefined, ns: "turbo", message: "" });
				var state = pair[0];
				var setState = pair[1];

				var fail = React.useCallback(function (error) {
					var message = messageOf(error);
					try { console.error("[dsh-turbo] bridge error:", error); } catch (_) { /* console optional */ }
					setState(function (prev) {
						return Object.assign({}, prev, { phase: "error", message: message });
					});
				}, []);

				var load = React.useCallback(function () {
					if (!settings || typeof settings.describe !== "function") {
						fail("remote.settings service is unavailable");
						return Promise.resolve();
					}
					var call;
					try {
						call = settings.describe();
					} catch (error) {
						fail(error);
						return Promise.resolve();
					}
					return Promise.resolve(call).then(function (answer) {
						var view = findTurboNamespace(answer);
						if (!view) {
							fail("no turbo ns; have: " + namespaceIds(answer));
							return;
						}
						setState({ phase: "ready", enabled: readEnabled(view), revision: view.revision, ns: String(view.ns), message: "" });
					}, fail);
				}, [fail]);

				React.useEffect(function () {
					load();
					var timer = setInterval(load, 5000);
					return function () { clearInterval(timer); };
				}, [load]);

				if (state.phase === "loading") return null;

				if (state.phase === "error") {
					return React.createElement("button", {
						type: "button",
						onClick: function () {
							setState(function (prev) { return Object.assign({}, prev, { phase: "loading" }); });
							load();
						},
						title: t("errorHint") + ": " + state.message,
						style: Object.assign({}, BASE_STYLE, {
							border: "1px dashed currentColor",
							background: "transparent",
							opacity: 0.6,
						}),
					}, "⚡ " + t("label") + " ✕ " + state.message.slice(0, 48));
				}

				var enabled = state.enabled;
				var onClick = function () {
					var next = !enabled;
					setState(function (prev) { return Object.assign({}, prev, { enabled: next }); });
					var call;
					try {
						call = settings.update(state.ns, { enabled: next }, state.revision);
					} catch (error) {
						fail(error);
						return;
					}
					Promise.resolve(call).then(function (result) {
						var view = unwrapRemote(result);
						if (!view || typeof view.ns === "undefined") {
							fail("no turbo ns; have: " + namespaceIds(result));
							return;
						}
						setState({ phase: "ready", enabled: readEnabled(view), revision: view.revision, ns: String(view.ns), message: "" });
					}, function (error) {
						// Revert the optimistic flip, then surface the refusal.
						setState(function (prev) { return Object.assign({}, prev, { enabled: !next }); });
						fail(error);
					});
				};

				return React.createElement("button", {
					type: "button",
					onClick: onClick,
					"aria-pressed": enabled,
					title: enabled ? t("onHint") : t("offHint"),
					style: Object.assign({}, BASE_STYLE, {
						border: enabled ? "1px solid currentColor" : "1px solid transparent",
						background: enabled ? "rgba(99, 140, 255, 0.28)" : "transparent",
						opacity: enabled ? 1 : 0.55,
					}),
				}, enabled ? "⚡ " + t("label") + " ✓" : "⚡ " + t("label"));
			}

			ctx.slots.inject("conversation.input.right", function () {
				return ctx.slots.register({
					name: "conversation.input.right",
					id: "turbo",
					order: 100,
					label: function () { return t("label"); },
				}, TurboButton);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
