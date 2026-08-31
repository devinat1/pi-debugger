import { createServer } from "node:net"

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a port")))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}
