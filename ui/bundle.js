// kandev plugin UI bundle — the frontend half of this plugin.
//
// This is a hand-written, NO-BUILD plain-JS ES module. It ships byte-for-byte
// inside the package tar.gz under ui/bundle.js, and kandev serves it directly
// from the extracted package at GET /api/plugins/<id>/ui/bundle.js, then
// dynamically imports it as a native ES module. There is nothing to build:
// edit this file and repackage (`make package` / `make package-host`).
//
// The contract, in three touch points:
//   - window.registerKandevPlugin(id, { initialize, destroy }) is the single
//     global entry point the host calls once this module has been evaluated.
//     `id` MUST match manifest.yaml's id.
//   - The `host` object handed to initialize() carries the SHARED host React
//     instance (`host.React`, `host.jsx` == host.React.createElement) plus a
//     curated design system (`host.ui`: Button, Card, Tooltip, ...), the app
//     store (`host.store`), and navigation (`host.navigate`). NEVER import or
//     bundle your own React — that breaks hook identity across the host tree.
//   - `registry` is where you declare nav items, routes, slot components, and
//     WS handlers. Every registration is tracked under this plugin's id, so
//     the host bulk-unregisters everything when the plugin is disabled.
//
// Rename "kandev-plugin-template" below to your plugin id, then keep / delete
// registrations to match what your plugin actually contributes.

// ---------------------------------------------------------------------------
// A tiny module-level pub/sub, backing a "tasks created since load" counter.
// Kept outside any component so the count survives route navigation and is
// shared by every subscriber. Delete this if you don't register a WS handler.
// ---------------------------------------------------------------------------
let taskCreatedCount = 0;
const counterListeners = new Set();

function setCounter(value) {
  taskCreatedCount = value;
  for (const listener of counterListeners) listener(taskCreatedCount);
}

// useTaskCreatedCounter re-renders its component whenever setCounter() fires.
// Built on host.React's useState/useEffect since this bundle can't ship its
// own useSyncExternalStore without bundling React.
function useTaskCreatedCounter(React) {
  const [count, setCount] = React.useState(taskCreatedCount);
  React.useEffect(() => {
    counterListeners.add(setCount);
    return () => counterListeners.delete(setCount);
  }, []);
  return count;
}

// ---------------------------------------------------------------------------
// A native route/page, rendered inside the kandev SPA (not an iframe) from the
// host's own design system. The host renders its first-party title bar above
// this page; here we contribute only the body.
// ---------------------------------------------------------------------------
function makePluginPage(host) {
  const { jsx: h, ui } = host;
  const { Card, CardHeader, CardTitle, CardContent } = ui;

  return function PluginPage() {
    const created = useTaskCreatedCounter(host.React);
    return h(
      "div",
      { style: { padding: "1rem", maxWidth: "40rem" } },
      h(
        Card,
        null,
        h(CardHeader, null, h(CardTitle, { id: "template-page-title" }, "Template plugin")),
        h(
          CardContent,
          null,
          h(
            "p",
            { id: "template-page-counter" },
            `tasks created since this page loaded: ${created}`,
          ),
          h(
            "p",
            { style: { marginTop: "0.75rem", color: "var(--muted-foreground)" } },
            "Edit ui/bundle.js to build your plugin's UI. This page reads a live",
            " counter fed by the task.created WS handler registered below.",
          ),
        ),
      ),
    );
  };
}

// ---------------------------------------------------------------------------
// A component for the "chat-input-actions" slot: an icon button rendered in
// the chat composer toolbar, beside the model picker, mic, and send. The host
// passes { sessionId, taskId, taskTitle } as slotProps, so the button knows
// which task/session the user is looking at.
// ---------------------------------------------------------------------------
function starIcon(h) {
  // Inline SVG — the bundle ships no build step and can't import an icon set
  // (that would mean bundling). Drawn at 16px to match first-party toolbar
  // icons. Swap for your own glyph.
  return h(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      width: 16,
      height: 16,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
    },
    h("path", {
      d: "M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 18l-6.1 3.4 1.4-6.8L2.2 9.9l6.9-.8L12 2z",
    }),
  );
}

function makeChatToolbarAction(host) {
  const { jsx: h, ui } = host;
  const { Button, Tooltip, TooltipTrigger, TooltipContent } = ui;

  return function ChatToolbarAction({ slotProps }) {
    const ctx = slotProps || {};
    const label = ctx.taskTitle || ctx.taskId;
    const tooltip = label ? `Template — open page (task: ${label})` : "Template — open page";

    return h(
      Tooltip,
      null,
      h(
        TooltipTrigger,
        { asChild: true },
        h(
          Button,
          {
            id: "template-chat-action",
            type: "button",
            variant: "ghost",
            size: "icon",
            className: "h-7 w-7 cursor-pointer hover:bg-muted/40",
            "aria-label": tooltip,
            onClick: () => host.navigate("/template"),
          },
          starIcon(h),
        ),
      ),
      h(TooltipContent, null, tooltip),
    );
  };
}

// ---------------------------------------------------------------------------
// Registration. Keep only what your plugin uses.
// ---------------------------------------------------------------------------
window.registerKandevPlugin("kandev-plugin-template", {
  initialize(registry, host) {
    // A sidebar entry. `icon` is a curated host icon name; it also becomes the
    // default topbar icon for the route registered on the same path.
    registry.registerNavItem({
      id: "template",
      label: "Template",
      path: "/template",
      icon: "puzzle",
      section: "main",
    });

    // A native route. The topbar title/icon default to the nav item above;
    // here we add a subtitle. Pass { topbar: false } to own the whole page
    // chrome yourself (host.ui.PageTopbar is available for that).
    registry.registerRoute("/template", makePluginPage(host), {
      topbar: { subtitle: "A starter kandev plugin page" },
    });

    // A WS handler: fires for every task.created message the SPA receives,
    // regardless of which component is mounted, since the counter lives at
    // module scope. Register handlers only for events you actually use.
    registry.registerWsHandler("task.created", () => {
      setCounter(taskCreatedCount + 1);
    });

    // A chat-composer toolbar button.
    registry.registerComponent("chat-input-actions", makeChatToolbarAction(host));
  },

  destroy() {
    // The host bulk-unregisters everything under this plugin's id; reset local
    // module state too so a re-enable starts clean.
    taskCreatedCount = 0;
    counterListeners.clear();
  },
});
