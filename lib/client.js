window.__ModuleLoader__.load({
	id: "dsh-spec-loop",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/client/index.js
		/**
		* dsh-spec-loop — client half.
		*
		* A one-line change card in the composer dock (`conversation.input.dock`,
		* the full-width row above the input card): current change-id, workflow
		* stage, task progress x/y, and the next `/spec` command to run. While the
		* agent implements, progress reads the standard `todos` projection (the
		* implement prompt mirrors tasks.md into todo_write) — zero RPC. The card's
		* state reads the host-computed `specLoop` projection through the standard
		* `useProjection` slot prop, so it survives restarts.
		*
		* UI text is localized through the harness `locale` service (zh + en).
		*/
		const inject = ["slots", "locale"];
		const ID = "dsh-spec-loop";
		const CSS = `
.spec-loop { display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  font-size: 11px; line-height: 1.5; opacity: .92; }
.spec-loop-glyph { opacity: .85; }
.spec-loop-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 600; }
.spec-loop-status { padding: 0 7px; border-radius: 999px; border: 1px solid rgba(127,127,127,.35); opacity: .85; white-space: nowrap; }
.spec-loop-status-active { opacity: 1; background: rgba(127,127,127,.16); }
.spec-loop-progress { opacity: .8; font-variant-numeric: tabular-nums; }
.spec-loop-progress-done { opacity: 1; }
.spec-loop-next { opacity: .6; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.spec-loop-hint { opacity: .55; }
`;
		/** One <style data-plugin> tag per load; the loader removes plugin-owned tags on unload. */
		function injectStyle() {
			const tagId = `${ID}/dock.css`;
			if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
				const tag = document.createElement("style");
				tag.dataset.plugin = ID;
				tag.dataset.pluginCss = tagId;
				tag.textContent = CSS;
				document.head.appendChild(tag);
			}
		}
		const ZH = {
			"card.init": "初始化规格工作流",
			"card.empty": "无活跃变更 — 新建",
			"status.proposing": "生成提案中…",
			"status.proposed": "已提案",
			"status.approved": "已批准",
			"status.implementing": "实现中",
			"status.implemented": "已实现",
			"status.verified": "已验收",
			"status.archived": "已归档",
			"next.proposed": "approve",
			"next.approved": "implement",
			"next.implemented": "verify",
			"next.verified": "archive",
			"progress.title": "任务进度（来自 todo_write）"
		};
		const EN = {
			"card.init": "initialize the spec workflow",
			"card.empty": "no active change — create one",
			"status.proposing": "Proposing…",
			"status.proposed": "Proposed",
			"status.approved": "Approved",
			"status.implementing": "Implementing",
			"status.implemented": "Implemented",
			"status.verified": "Verified",
			"status.archived": "Archived",
			"next.proposed": "approve",
			"next.approved": "implement",
			"next.implemented": "verify",
			"next.verified": "archive",
			"progress.title": "task progress (from todo_write)"
		};
		const NEXT_FOR_STATUS = {
			proposed: "next.proposed",
			approved: "next.approved",
			implemented: "next.implemented",
			verified: "next.verified"
		};
		function apply(ctx) {
			injectStyle();
			let t = (key) => key;
			try {
				ctx.locale.register(ID, "zh", ZH);
				ctx.locale.register(ID, "en", EN);
				t = ctx.locale.bind(ID);
			} catch (error) {
				console.error("dsh-spec-loop: locale registration failed: " + String(error));
			}
			function SpecDock(props) {
				const state = props.useProjection("specLoop");
				const todos = props.useProjection("todos");
				const [, setLocaleTick] = (0, react.useState)(0);
				(0, react.useEffect)(() => {
					return ctx.locale.subscribe(() => setLocaleTick((x) => x + 1));
				}, []);
				const change = state ? state.change : null;
				const initialized = state ? state.initialized : false;
				if (!change) {
					if (!initialized) return (0, react.createElement)("div", { className: "spec-loop" }, (0, react.createElement)("span", { className: "spec-loop-glyph" }, "📐"), (0, react.createElement)("span", { className: "spec-loop-hint" }, t("card.init") + " — "), (0, react.createElement)("span", { className: "spec-loop-next" }, "/spec init"));
					return (0, react.createElement)("div", { className: "spec-loop" }, (0, react.createElement)("span", { className: "spec-loop-glyph" }, "📐"), (0, react.createElement)("span", { className: "spec-loop-hint" }, t("card.empty") + " — "), (0, react.createElement)("span", { className: "spec-loop-next" }, "/spec new <goal>"));
				}
				const busy = change.status === "proposing" || change.status === "implementing";
				const idLabel = change.id ? change.id : change.title && change.title !== "(untitled)" ? change.title : "…";
				const progress = Array.isArray(todos) ? {
					done: todos.filter((item) => item && item.status === "completed").length,
					total: todos.length
				} : null;
				const nextKey = NEXT_FOR_STATUS[change.status];
				return (0, react.createElement)("div", { className: "spec-loop" }, (0, react.createElement)("span", { className: "spec-loop-glyph" }, "📐"), (0, react.createElement)("span", { className: "spec-loop-id" }, idLabel), (0, react.createElement)("span", { className: "spec-loop-status" + (busy ? " spec-loop-status-active" : "") }, t("status." + change.status)), progress && (change.status === "implementing" || change.status === "implemented") ? (0, react.createElement)("span", {
					className: "spec-loop-progress" + (progress.done === progress.total && progress.total > 0 ? " spec-loop-progress-done" : ""),
					title: t("progress.title")
				}, progress.done + "/" + progress.total) : null, nextKey ? (0, react.createElement)("span", { className: "spec-loop-next" }, "/spec " + t(nextKey) + (change.status === "proposed" ? " " + change.id : "")) : null);
			}
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "spec-loop",
				order: 0,
				label: "Spec loop change card"
			}, (props) => (0, react.createElement)(SpecDock, props)));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map