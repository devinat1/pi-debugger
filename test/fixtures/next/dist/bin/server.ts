const childTarget = "request-server"
Reflect.set(globalThis, "childTarget", childTarget)
setTimeout(() => {}, 50)
setInterval(() => {}, 1_000)
