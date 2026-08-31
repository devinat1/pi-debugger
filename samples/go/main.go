package main

import "time"

func add(a, b int) int {
	total := a + b
	return total
}

func main() {
	println("initial:", add(2, 3))
	for range time.Tick(time.Second) {
		println("tick:", add(4, 5))
	}
}
