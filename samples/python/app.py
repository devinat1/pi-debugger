def add(a, b):
    total = a + b
    return total


print(f"Initial total: {add(2, 3)}.", flush=True)
while True:
    print(f"Tick total: {add(4, 5)}.", flush=True)
    __import__("time").sleep(1)
