function add(a, b) {
  const total = a + b
  return total
}

console.log(`Initial total: ${add(2, 3)}.`)
setInterval(() => console.log(`Tick total: ${add(4, 5)}.`), 1_000)
