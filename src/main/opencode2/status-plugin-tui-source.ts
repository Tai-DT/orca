/**
 * TUI adapter for the OpenCode 2 status plugin. The module Orca writes as a server plugin
 * is also installed as a TUI plugin; in a TUI process setup() lands here. The TUI runs in
 * its pane's PTY, so the engine's env stamp names the right pane, and the engine sees only
 * sessions this pane owns — the one-pane-per-engine invariant it was built on.
 */
export function getOpenCode2TuiSource(): string[] {
  return String.raw`
const TUI_ROUTE_POLL_MS = 100;
const TUI_EARLY_EVENT_ROOTS_MAX = 32;

function isOpenCode2TuiContext(ctx) {
  return typeof ctx?.ui?.router?.current === "function" && typeof ctx?.data?.listen === "function";
}

// Engine state that still needs this root's events before it can settle.
function engineHoldsRoot(rootSessionID) {
  if (busyRootOwnerBySessionID.has(rootSessionID)) return true;
  for (const busyChild of busyChildRootByKey.values()) {
    if (busyChild.sessionID === rootSessionID) return true;
  }
  for (const provisional of provisionalBusyByKey.values()) {
    if (provisional.sessionID === rootSessionID) return true;
  }
  for (const attention of pendingAttentionByKey.values()) {
    if ((attention.properties?.sessionID || attention.sourceSessionID) === rootSessionID) return true;
  }
  return false;
}

async function setupOpenCode2Tui(ctx) {
  const noop = async () => {};
  // Why: post() needs this pane's key, so a TUI outside an Orca pane has nothing to report.
  if (!process.env.ORCA_PANE_KEY) return noop;
  let hooks;
  try {
    const data = ctx.data.session;
    // Why: OpenCode 1 loads no plugin directories, but refusing it here keeps a future 1.x
    // loader from running a second producer beside the 1.x server plugin.
    if (/^1\./.test(String(ctx.app?.version || ""))) return noop;
    if (typeof data?.get !== "function" || typeof data.status !== "function") return noop;
    const client = {
      session: {
        get: async (input, options) => {
          const sessionID = input?.sessionID ?? input?.path?.id;
          const cached = data.get(sessionID);
          if (cached && cached.id === sessionID) return { data: cached };
          const result = await ctx.client?.session?.get?.({ sessionID }, options);
          const info = result && typeof result.id === "string" ? result : result?.data;
          return info && info.id === sessionID ? { data: info } : undefined;
        },
      },
    };
    hooks = await OrcaOpenCodeStatusPlugin({ client });
    if (!hooks || typeof hooks.event !== "function") return noop;
    const engine = hooks;

    let disposed = false;
    let chain = Promise.resolve();
    let syncQueued = false;
    let queuedEvents = 0;
    let routeRoot;
    const owned = new Set();
    // Root events seen before this pane owned the root (the route can switch after them).
    const early = new Map();

    const run = (task) => {
      chain = chain.then(async () => {
        if (!disposed) await task();
      }).catch(() => {});
      return chain;
    };
    const forward = (event) => engine.event({ event });
    const rootOf = async (sessionID) => {
      const resolved = await resolveRootSessionID(client, sessionID);
      if (resolved) return resolved;
      return typeof data.root === "function" ? data.root(sessionID) || sessionID : sessionID;
    };
    const currentRoute = () => {
      const route = ctx.ui.router.current();
      if (route?.type !== "session" || typeof route.sessionID !== "string") return undefined;
      return typeof data.root === "function" ? data.root(route.sessionID) || route.sessionID : route.sessionID;
    };
    const family = (rootSessionID) =>
      new Set([rootSessionID, ...(typeof data.family === "function" ? data.family(rootSessionID) || [] : [])]);
    const familyRunning = (rootSessionID) =>
      [...family(rootSessionID)].some((id) => data.status(id) === "running");
    const familyBlocked = (rootSessionID) =>
      [...family(rootSessionID)].some((id) => (data.permission?.list?.(id) || []).length > 0 || (data.form?.list?.(id) || []).length > 0);
    const remember = (rootSessionID, event) => {
      const held = early.get(rootSessionID) || [];
      early.delete(rootSessionID);
      early.set(rootSessionID, [...held.filter((item) => item.type !== event.type), event]);
      if (early.size > TUI_EARLY_EVENT_ROOTS_MAX) early.delete(early.keys().next().value);
    };

    async function own(rootSessionID) {
      if (owned.has(rootSessionID)) return;
      owned.add(rootSessionID);
      const held = early.get(rootSessionID) || [];
      early.delete(rootSessionID);
      for (const event of held) await forward(event);
      await reassert(rootSessionID);
    }

    // Re-derives a running root's Busy and open blockers from the session data.
    async function reassert(rootSessionID) {
      if (data.status(rootSessionID) !== "running") return;
      await forward({ type: "session.status", properties: { sessionID: rootSessionID, status: { type: "busy" } } });
      for (const member of family(rootSessionID)) {
        for (const request of data.permission?.list?.(member) || []) {
          const translated = translateOpenCode2Event("permission.asked", request);
          if (translated) await forward(translated);
        }
        for (const form of data.form?.list?.(member) || []) {
          const translated = translateOpenCode2Event("form.created", { form });
          if (translated) await forward(translated);
        }
      }
    }

    async function sync() {
      routeRoot = currentRoute();
      if (routeRoot && !owned.has(routeRoot) && data.status(routeRoot) === "running") {
        await own(routeRoot);
      }
      // Why keep a root past navigation: a pane that started a turn must still reach Done
      // when the user browses to another session mid-turn, as it did with one server per pane.
      for (const rootSessionID of owned) {
        if (
          rootSessionID !== routeRoot &&
          data.status(rootSessionID) !== "running" &&
          !engineHoldsRoot(rootSessionID)
        ) {
          owned.delete(rootSessionID);
        }
      }
      // Why wait for an empty queue: the session data applies each event before it reaches this
      // plugin, so it runs ahead of the engine until the queue drains; a mismatch after that is
      // an execution start or end missed across a reconnect, which the data re-hydrates.
      if (queuedEvents > 0) return;
      for (const rootSessionID of owned) {
        if (!engineHoldsRoot(rootSessionID)) {
          await reassert(rootSessionID);
        } else if (busyRootOwnerBySessionID.has(rootSessionID) && !familyRunning(rootSessionID) && !familyBlocked(rootSessionID)) {
          await forward({ type: "session.status", properties: { sessionID: rootSessionID, status: { type: "idle" } } });
        }
      }
    }

    async function handle(input) {
      await sync();
      if (input.type === "session.deleted") {
        const sessionID = input.data?.sessionID;
        early.delete(sessionID);
        if (!owned.has(sessionID)) return;
        owned.delete(sessionID);
        // A deleted root never settles on its own; retire whatever the engine still holds.
        await forward({ type: "session.status", properties: { sessionID, status: { type: "idle" } } });
        return;
      }
      let translated;
      if (input.type === "session.inbox.enqueued") {
        // Why TUI-only: the server takes the prompt from session.hook("prompt"), which a TUI lacks.
        const item = input.data?.item;
        if (item?.type !== "user" || typeof item.payload?.text !== "string") return;
        translated = {
          type: "session.next.prompt.admitted",
          properties: { sessionID: input.data.sessionID, messageID: input.data.inboxID, prompt: { text: item.payload.text } },
        };
      } else {
        translated = translateOpenCode2Event(input.type, input.data);
      }
      if (!translated) return;
      const sessionID = translated.properties?.sessionID ?? translated.properties?.info?.id;
      if (typeof sessionID !== "string" || !sessionID) return;
      const rootSessionID = await rootOf(sessionID);
      if (!owned.has(rootSessionID)) {
        if (input.type === "session.execution.started" && sessionID === rootSessionID && rootSessionID === routeRoot) {
          await own(rootSessionID);
        } else {
          if (sessionID === rootSessionID && (translated.type === "session.created" || translated.type === "session.next.prompt.admitted")) {
            remember(rootSessionID, translated);
          }
          return;
        }
      }
      await forward(translated);
    }

    const unsubscribe = ctx.data.listen(({ details } = {}) => {
      if (disposed || !details || typeof details.type !== "string") return;
      queuedEvents += 1;
      void run(async () => {
        try {
          await handle(details);
        } finally {
          queuedEvents -= 1;
        }
      });
    });
    const poll = setInterval(() => {
      if (syncQueued || disposed) return;
      syncQueued = true;
      void run(async () => {
        syncQueued = false;
        await sync();
      });
    }, TUI_ROUTE_POLL_MS);
    if (poll.unref) poll.unref();
    void run(sync);
    return async () => {
      try {
        disposed = true;
        clearInterval(poll);
        try {
          if (typeof unsubscribe === "function") unsubscribe();
        } finally {
          try {
            await chain;
          } finally {
            await engine.dispose?.();
          }
        }
      } catch {
        // Why: cleanup runs during plugin unload; a throw here also fails the plugin.
      }
    };
  } catch {
    try { await hooks?.dispose?.(); } catch {}
    return noop;
  }
}
`.split('\n')
}
