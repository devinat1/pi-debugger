package main

import "time"

func add(a, b int) int {
	total := a + b
	return total
}

func main() {
	println("Initial total:", add(2, 3), ".")
	for range time.Tick(time.Second) {
		println("Tick total:", add(4, 5), ".")
	}
}
