def add(a, b):
    total = a + b
    return total


print(f"initial: {add(2, 3)}", flush=True)
while True:
    print(f"tick: {add(4, 5)}", flush=True)
    __import__("time").sleep(1)
