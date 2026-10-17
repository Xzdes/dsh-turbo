/**
 * dsh-turbo — web client half (v4: effort-aware).
 *
 * Adds a "Turbo" toggle to the composer tool row (the
 * `conversation.input.right` list slot, just before the send action).
 * The button reads and writes the host plugin's volatile Config fields
 * (`enabled`, `effortControl`, `effort`) through the settings controller's
 * Remote namespace (`remote.settings`), so every flip applies live: the
 * loader commits volatile edits in place — no fiber restart.
 *
 * Left click   — toggles the whole pack (speed tools + forced effort).
 * Right click  — cycles the forced reasoning effort: low → off → medium → high.
 * The pill shows the forced level while the pack is on (⚡ Турбо ✓ · low).
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

		/** Right-click cycle order; ids match the host EFFORT_LEVELS. */
		var EFFORT_CYCLE = ["low", "off", "medium", "high"];

		/** Button dictionaries, keyed by locale namespace. */
		var DICTS = {
			en: {
				label: "Turbo",
				onHint: "Turbo is ON — speed tools active, reasoning effort forced to {effort}. Right-click cycles the level, left click disables.",
				offHint: "Turbo is OFF — click to enable the agent speed pack.",
				errorHint: "Turbo bridge error (click to retry)",
				untouched: "session default",
			},
			ru: {
				label: "Турбо",
				onHint: "Турбо включён — инструменты ускорения активны, уровень рассуждений принудительно «{effort}». Правый клик меняет уровень, левый выключает.",
				offHint: "Турбо выключен — нажмите, чтобы включить пакет ускорения агента.",
				errorHint: "Турбо: ошибка связи (нажмите, чтобы повторить)",
				untouched: "без вмешательства",
			},
			zh: {
				label: "Turbo",
				onHint: "Turbo 已开启 — 加速工具生效，推理等级强制为 {effort}。右键切换等级，左键关闭。",
				offHint: "Turbo 已关闭 — 点击启用代理加速包。",
				errorHint: "Turbo 连接错误（点击重试）",
				untouched: "不干预",
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

		/** Read the volatile flags from a namespace view; absent means schema default. */
		function readFlags(view) {
			var value = (view && view.value) || {};
			return {
				enabled: typeof value.enabled === "boolean" ? value.enabled : true,
				effortControl: typeof value.effortControl === "boolean" ? value.effortControl : true,
				effort: typeof value.effort === "string" ? value.effort : "low",
			};
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
				var pair = React.useState({
					phase: "loading",
					enabled: true,
					effortControl: true,
					effort: "low",
					revision: undefined,
					ns: "turbo",
					message: "",
				});
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
						setState(Object.assign(
							{ phase: "ready", revision: view.revision, ns: String(view.ns), message: "" },
							readFlags(view)
						));
					}, fail);
				}, [fail]);

				React.useEffect(function () {
					load();
					var timer = setInterval(load, 5000);
					return function () { clearInterval(timer); };
				}, [load]);

				/** Optimistic volatile-config write through the settings bridge. */
				function update(patch, optimistic) {
					var snapshot = { enabled: state.enabled, effortControl: state.effortControl, effort: state.effort };
					setState(function (prev) { return Object.assign({}, prev, optimistic); });
					var call;
					try {
						call = settings.update(state.ns, patch, state.revision);
					} catch (error) {
						setState(function (prev) { return Object.assign({}, prev, snapshot); });
						fail(error);
						return;
					}
					Promise.resolve(call).then(function (result) {
						var view = unwrapRemote(result);
						if (!view || typeof view.ns === "undefined") {
							fail("no turbo ns; have: " + namespaceIds(result));
							return;
						}
						setState(Object.assign(
							{ phase: "ready", revision: view.revision, ns: String(view.ns), message: "" },
							readFlags(view)
						));
					}, function (error) {
						// Revert the optimistic flip, then surface the refusal.
						setState(function (prev) { return Object.assign({}, prev, snapshot); });
						fail(error);
					});
				}

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
				var normalizedEffort = String(state.effort || "").trim().toLowerCase();
				var effortShown = state.effortControl !== false && EFFORT_CYCLE.indexOf(normalizedEffort) !== -1
					? normalizedEffort
					: "";

				var onClick = function () {
					update({ enabled: !enabled }, { enabled: !enabled });
				};

				var onContextMenu = function (event) {
					event.preventDefault();
					var index = EFFORT_CYCLE.indexOf(normalizedEffort);
					var next = EFFORT_CYCLE[(index + 1) % EFFORT_CYCLE.length];
					update({ effort: next }, { effort: next });
				};

				var hintText = enabled
					? String(t("onHint")).replace("{effort}", effortShown !== "" ? effortShown : t("untouched"))
					: t("offHint");

				return React.createElement("button", {
					type: "button",
					onClick: onClick,
					onContextMenu: onContextMenu,
					"aria-pressed": enabled,
					title: hintText,
					style: Object.assign({}, BASE_STYLE, {
						border: enabled ? "1px solid currentColor" : "1px solid transparent",
						background: enabled ? "rgba(99, 140, 255, 0.28)" : "transparent",
						opacity: enabled ? 1 : 0.55,
					}),
				}, enabled
					? "⚡ " + t("label") + " ✓" + (effortShown !== "" ? " · " + effortShown : "")
					: "⚡ " + t("label"));
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
