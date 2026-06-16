"""Generate ~14 small, self-contained, well-documented Python source files + a queries.xlsx whose
answers are taken from the code we author here (so the ground truth is correct by construction).
Questions target what each file implements, its functions, default arguments, and behavior.

Run:  python dataset_builders/build_python_dataset.py
Out:  Python_Files/*.py  +  Python_Files/queries.xlsx
"""
from __future__ import annotations

import os

import pandas as pd

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "Python_Files")
os.makedirs(OUT, exist_ok=True)

FILES: list[dict] = [
    {"name": "binary_search.py", "code": '''"""Binary search over a sorted list. Time complexity: O(log n)."""


def binary_search(arr, target):
    """Return the index of `target` in the sorted list `arr`, or -1 if not present."""
    lo, hi = 0, len(arr) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if arr[mid] == target:
            return mid
        if arr[mid] < target:
            lo = mid + 1
        else:
            hi = mid - 1
    return -1
''', "qas": [
        ("Which algorithm does binary_search.py implement?", "Binary search over a sorted list."),
        ("What is the time complexity of the binary search in binary_search.py?", "O(log n)."),
        ("What does the binary_search function return when the target is not found?", "-1."),
    ]},

    {"name": "bubble_sort.py", "code": '''"""Bubble sort: repeatedly swap adjacent out-of-order elements. Time complexity: O(n^2)."""


def bubble_sort(arr):
    """Return a new list with the elements of `arr` sorted in ascending order."""
    a = list(arr)
    n = len(a)
    for i in range(n):
        for j in range(0, n - i - 1):
            if a[j] > a[j + 1]:
                a[j], a[j + 1] = a[j + 1], a[j]
    return a
''', "qas": [
        ("What sorting algorithm is implemented in bubble_sort.py?", "Bubble sort."),
        ("What is the worst-case time complexity of bubble_sort?", "O(n^2)."),
        ("Does bubble_sort sort in ascending or descending order?", "Ascending order."),
    ]},

    {"name": "quick_sort.py", "code": '''"""Quicksort using the last element as pivot. Average time complexity: O(n log n)."""


def quick_sort(arr):
    """Return a new sorted list using the divide-and-conquer quicksort algorithm."""
    if len(arr) <= 1:
        return list(arr)
    pivot = arr[-1]
    smaller = [x for x in arr[:-1] if x <= pivot]
    larger = [x for x in arr[:-1] if x > pivot]
    return quick_sort(smaller) + [pivot] + quick_sort(larger)
''', "qas": [
        ("Which element does quick_sort.py use as the pivot?", "The last element of the list."),
        ("What is the average time complexity of quick_sort?", "O(n log n)."),
        ("Is quick_sort in quick_sort.py implemented recursively or iteratively?", "Recursively."),
    ]},

    {"name": "fibonacci.py", "code": '''"""Iterative Fibonacci sequence generator."""


def fibonacci(n):
    """Return a list of the first `n` Fibonacci numbers, starting 0, 1, 1, 2, ..."""
    seq = []
    a, b = 0, 1
    for _ in range(n):
        seq.append(a)
        a, b = b, a + b
    return seq
''', "qas": [
        ("What are the first two numbers of the sequence produced by fibonacci.py?", "0 and 1."),
        ("Is the fibonacci function in fibonacci.py iterative or recursive?", "Iterative."),
        ("What does fibonacci(5) return?", "[0, 1, 1, 2, 3]."),
    ]},

    {"name": "factorial.py", "code": '''"""Recursive factorial of a non-negative integer."""


def factorial(n):
    """Return n! (n factorial). Raises ValueError for negative input."""
    if n < 0:
        raise ValueError("factorial is undefined for negative numbers")
    if n <= 1:
        return 1
    return n * factorial(n - 1)
''', "qas": [
        ("What does factorial.py compute?", "The factorial (n!) of a non-negative integer."),
        ("What happens if factorial is called with a negative number?", "It raises a ValueError."),
        ("Is the factorial function recursive or iterative?", "Recursive."),
    ]},

    {"name": "palindrome.py", "code": '''"""Check whether a string is a palindrome, ignoring case and spaces."""


def is_palindrome(text):
    """Return True if `text` reads the same forwards and backwards (case/space insensitive)."""
    cleaned = "".join(c.lower() for c in text if c.isalnum())
    return cleaned == cleaned[::-1]
''', "qas": [
        ("What does palindrome.py check for?", "Whether a string is a palindrome."),
        ("Does is_palindrome ignore case and spaces?", "Yes, it ignores case and non-alphanumeric characters."),
        ("What does is_palindrome return for the input 'Racecar'?", "True."),
    ]},

    {"name": "stack.py", "code": '''"""A simple LIFO stack built on a Python list."""


class Stack:
    """Last-In-First-Out stack with push, pop, peek, and is_empty operations."""

    def __init__(self):
        self._items = []

    def push(self, item):
        self._items.append(item)

    def pop(self):
        return self._items.pop()

    def peek(self):
        return self._items[-1]

    def is_empty(self):
        return len(self._items) == 0
''', "qas": [
        ("What data structure does stack.py implement?", "A LIFO (last-in-first-out) stack."),
        ("Which methods does the Stack class provide?", "push, pop, peek, and is_empty."),
        ("What does the peek method return?", "The top item of the stack without removing it."),
    ]},

    {"name": "linked_list.py", "code": '''"""A singly linked list with append and to_list operations."""


class Node:
    def __init__(self, value):
        self.value = value
        self.next = None


class LinkedList:
    """Singly linked list. `append` adds to the tail; `to_list` returns a Python list."""

    def __init__(self):
        self.head = None

    def append(self, value):
        node = Node(value)
        if self.head is None:
            self.head = node
            return
        cur = self.head
        while cur.next:
            cur = cur.next
        cur.next = node

    def to_list(self):
        out, cur = [], self.head
        while cur:
            out.append(cur.value)
            cur = cur.next
        return out
''', "qas": [
        ("What data structure does linked_list.py implement?", "A singly linked list."),
        ("Where does the append method add new nodes?", "At the tail (end) of the list."),
        ("What class represents a single element in linked_list.py?", "The Node class."),
    ]},

    {"name": "caesar_cipher.py", "code": '''"""Caesar cipher: shift each letter by a fixed amount. Default shift is 3."""


def encrypt(text, shift=3):
    """Return `text` with each ASCII letter shifted forward by `shift` positions."""
    result = []
    for ch in text:
        if ch.isupper():
            result.append(chr((ord(ch) - 65 + shift) % 26 + 65))
        elif ch.islower():
            result.append(chr((ord(ch) - 97 + shift) % 26 + 97))
        else:
            result.append(ch)
    return "".join(result)


def decrypt(text, shift=3):
    """Inverse of encrypt: shift letters backward by `shift`."""
    return encrypt(text, -shift)
''', "qas": [
        ("What cipher is implemented in caesar_cipher.py?", "The Caesar cipher."),
        ("What is the default shift used by the encrypt function?", "3."),
        ("How does caesar_cipher.py implement decryption?", "By shifting backward (encrypt with -shift)."),
    ]},

    {"name": "prime_sieve.py", "code": '''"""Sieve of Eratosthenes: list all primes up to a limit."""


def primes_up_to(limit):
    """Return a list of all prime numbers <= `limit` using the Sieve of Eratosthenes."""
    if limit < 2:
        return []
    sieve = [True] * (limit + 1)
    sieve[0] = sieve[1] = False
    for i in range(2, int(limit ** 0.5) + 1):
        if sieve[i]:
            for j in range(i * i, limit + 1, i):
                sieve[j] = False
    return [n for n, is_p in enumerate(sieve) if is_p]
''', "qas": [
        ("Which algorithm does prime_sieve.py use to find primes?", "The Sieve of Eratosthenes."),
        ("What does primes_up_to(10) return?", "[2, 3, 5, 7]."),
        ("What does primes_up_to return when the limit is less than 2?", "An empty list."),
    ]},

    {"name": "temperature_converter.py", "code": '''"""Convert temperatures between Celsius and Fahrenheit."""


def celsius_to_fahrenheit(c):
    """Convert Celsius to Fahrenheit: F = C * 9/5 + 32."""
    return c * 9 / 5 + 32


def fahrenheit_to_celsius(f):
    """Convert Fahrenheit to Celsius: C = (F - 32) * 5/9."""
    return (f - 32) * 5 / 9
''', "qas": [
        ("What does temperature_converter.py convert between?", "Celsius and Fahrenheit."),
        ("What formula does celsius_to_fahrenheit use?", "F = C * 9/5 + 32."),
        ("What is 100 degrees Celsius in Fahrenheit according to this module?", "212."),
    ]},

    {"name": "word_counter.py", "code": '''"""Count word frequencies in a piece of text."""

from collections import Counter


def word_count(text):
    """Return a dict mapping each lowercased word to its number of occurrences."""
    words = text.lower().split()
    return dict(Counter(words))


def most_common(text, n=1):
    """Return the `n` most common (word, count) pairs."""
    return Counter(text.lower().split()).most_common(n)
''', "qas": [
        ("What does word_counter.py compute?", "Word frequencies in a text."),
        ("Does word_count treat words case-sensitively?", "No, it lowercases the text first."),
        ("Which standard-library class does word_counter.py use for counting?", "collections.Counter."),
    ]},

    {"name": "bank_account.py", "code": '''"""A minimal bank account with deposit, withdraw, and overdraft protection."""


class BankAccount:
    """Tracks a balance. Withdrawals that exceed the balance raise ValueError."""

    def __init__(self, owner, balance=0.0):
        self.owner = owner
        self.balance = balance

    def deposit(self, amount):
        if amount <= 0:
            raise ValueError("deposit must be positive")
        self.balance += amount
        return self.balance

    def withdraw(self, amount):
        if amount > self.balance:
            raise ValueError("insufficient funds")
        self.balance -= amount
        return self.balance
''', "qas": [
        ("What class is defined in bank_account.py?", "The BankAccount class."),
        ("What happens if you withdraw more than the balance?", "It raises a ValueError ('insufficient funds')."),
        ("What is the default starting balance of a BankAccount?", "0.0."),
    ]},

    {"name": "matrix_ops.py", "code": '''"""Basic matrix operations: transpose and multiply (lists of lists)."""


def transpose(matrix):
    """Return the transpose of a 2D matrix."""
    return [list(row) for row in zip(*matrix)]


def multiply(a, b):
    """Return the matrix product a x b. Raises ValueError on incompatible shapes."""
    if len(a[0]) != len(b):
        raise ValueError("incompatible dimensions")
    return [[sum(a[i][k] * b[k][j] for k in range(len(b)))
             for j in range(len(b[0]))] for i in range(len(a))]
''', "qas": [
        ("What two matrix operations does matrix_ops.py provide?", "transpose and multiply."),
        ("What does the multiply function raise on incompatible matrix shapes?", "A ValueError."),
        ("How are matrices represented in matrix_ops.py?", "As lists of lists (2D lists)."),
    ]},
]

QUERIES = []
qid = 0
for f in FILES:
    with open(os.path.join(OUT, f["name"]), "w", encoding="utf-8") as fh:
        fh.write(f["code"])
    for q, a in f["qas"]:
        qid += 1
        QUERIES.append({"query_id": f"py_{qid:03d}", "question": q,
                        "reference_answer": a, "source_file": f["name"]})

pd.DataFrame(QUERIES).to_excel(os.path.join(OUT, "queries.xlsx"), index=False)
print(f"Python: wrote {len(FILES)} .py files + queries.xlsx ({len(QUERIES)} queries) -> {OUT}")
