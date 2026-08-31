const childTarget = "request-server"
Reflect.set(globalThis, "childTarget", childTarget)
setTimeout(() => void import("../../.next/dev/server/chunks/[root]__lazy.js"), 50)
setInterval(() => {}, 1_000)
//# sourceMappingURL=server.js.map
