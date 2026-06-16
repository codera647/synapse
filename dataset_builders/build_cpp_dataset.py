"""Generate ~14 small, self-contained, commented C++ source files + a queries.xlsx whose answers come
from the code we author here (correct by construction). Questions target what each file implements,
its functions, complexity, and behavior.

Run:  python dataset_builders/build_cpp_dataset.py
Out:  Cpp_Files/*.cpp  +  Cpp_Files/queries.xlsx
"""
from __future__ import annotations

import os

import pandas as pd

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "Cpp_Files")
os.makedirs(OUT, exist_ok=True)

FILES: list[dict] = [
    {"name": "binary_search.cpp", "code": '''// Binary search over a sorted array. Time complexity: O(log n).
#include <vector>

// Returns the index of `target` in the sorted vector `arr`, or -1 if absent.
int binary_search(const std::vector<int>& arr, int target) {
    int lo = 0, hi = (int)arr.size() - 1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;
        if (arr[mid] == target) return mid;
        if (arr[mid] < target) lo = mid + 1;
        else hi = mid - 1;
    }
    return -1;
}
''', "qas": [
        ("Which algorithm does binary_search.cpp implement?", "Binary search over a sorted array."),
        ("What is the time complexity of binary_search.cpp?", "O(log n)."),
        ("What does binary_search return when the target is not in the array?", "-1."),
    ]},

    {"name": "bubble_sort.cpp", "code": '''// Bubble sort: swap adjacent out-of-order elements. Time complexity: O(n^2).
#include <vector>

// Sorts `arr` in place in ascending order.
void bubble_sort(std::vector<int>& arr) {
    int n = (int)arr.size();
    for (int i = 0; i < n - 1; ++i)
        for (int j = 0; j < n - i - 1; ++j)
            if (arr[j] > arr[j + 1])
                std::swap(arr[j], arr[j + 1]);
}
''', "qas": [
        ("What sorting algorithm is in bubble_sort.cpp?", "Bubble sort."),
        ("What is the time complexity of bubble_sort.cpp?", "O(n^2)."),
        ("Does bubble_sort.cpp sort in place or return a new array?", "In place."),
    ]},

    {"name": "merge_sort.cpp", "code": '''// Merge sort: stable divide-and-conquer sort. Time complexity: O(n log n).
#include <vector>

void merge(std::vector<int>& a, int l, int m, int r) {
    std::vector<int> left(a.begin() + l, a.begin() + m + 1);
    std::vector<int> right(a.begin() + m + 1, a.begin() + r + 1);
    int i = 0, j = 0, k = l;
    while (i < (int)left.size() && j < (int)right.size())
        a[k++] = (left[i] <= right[j]) ? left[i++] : right[j++];
    while (i < (int)left.size()) a[k++] = left[i++];
    while (j < (int)right.size()) a[k++] = right[j++];
}

void merge_sort(std::vector<int>& a, int l, int r) {
    if (l >= r) return;
    int m = l + (r - l) / 2;
    merge_sort(a, l, m);
    merge_sort(a, m + 1, r);
    merge(a, l, m, r);
}
''', "qas": [
        ("Which sorting algorithm does merge_sort.cpp implement?", "Merge sort."),
        ("What is the time complexity of merge_sort.cpp?", "O(n log n)."),
        ("Is the merge sort in merge_sort.cpp stable?", "Yes, it is stable."),
    ]},

    {"name": "fibonacci.cpp", "code": '''// Iterative Fibonacci number. Returns the n-th Fibonacci number (0-indexed).
long long fibonacci(int n) {
    long long a = 0, b = 1;
    for (int i = 0; i < n; ++i) {
        long long t = a + b;
        a = b;
        b = t;
    }
    return a;
}
''', "qas": [
        ("What does fibonacci.cpp compute?", "The n-th Fibonacci number."),
        ("Is fibonacci.cpp iterative or recursive?", "Iterative."),
        ("What does fibonacci(0) return in fibonacci.cpp?", "0."),
    ]},

    {"name": "factorial.cpp", "code": '''// Recursive factorial of a non-negative integer.
long long factorial(int n) {
    if (n <= 1) return 1;
    return (long long)n * factorial(n - 1);
}
''', "qas": [
        ("What does factorial.cpp compute?", "The factorial (n!) of an integer."),
        ("Is the factorial in factorial.cpp recursive or iterative?", "Recursive."),
        ("What does factorial(0) return?", "1."),
    ]},

    {"name": "is_prime.cpp", "code": '''// Primality test by trial division up to sqrt(n). Time complexity: O(sqrt(n)).
#include <cmath>

bool is_prime(int n) {
    if (n < 2) return false;
    for (int i = 2; (long long)i * i <= n; ++i)
        if (n % i == 0) return false;
    return true;
}
''', "qas": [
        ("What does is_prime.cpp do?", "Tests whether a number is prime."),
        ("What is the time complexity of is_prime.cpp?", "O(sqrt(n))."),
        ("What does is_prime return for inputs less than 2?", "false."),
    ]},

    {"name": "gcd.cpp", "code": '''// Greatest common divisor using the Euclidean algorithm.
int gcd(int a, int b) {
    while (b != 0) {
        int t = b;
        b = a % b;
        a = t;
    }
    return a;
}
''', "qas": [
        ("Which algorithm does gcd.cpp use?", "The Euclidean algorithm."),
        ("What does gcd.cpp compute?", "The greatest common divisor of two integers."),
        ("Is the gcd in gcd.cpp iterative or recursive?", "Iterative."),
    ]},

    {"name": "stack.cpp", "code": '''// A simple LIFO stack class backed by a vector.
#include <vector>
#include <stdexcept>

class Stack {
    std::vector<int> items;
public:
    void push(int x) { items.push_back(x); }
    int pop() {
        if (items.empty()) throw std::runtime_error("stack empty");
        int v = items.back();
        items.pop_back();
        return v;
    }
    int top() const { return items.back(); }
    bool empty() const { return items.empty(); }
};
''', "qas": [
        ("What data structure does stack.cpp implement?", "A LIFO (last-in-first-out) stack."),
        ("What does pop() throw when the stack is empty?", "A std::runtime_error."),
        ("Which container backs the Stack class in stack.cpp?", "std::vector."),
    ]},

    {"name": "linked_list.cpp", "code": '''// Singly linked list with push_back and size.
struct Node {
    int value;
    Node* next;
    Node(int v) : value(v), next(nullptr) {}
};

class LinkedList {
    Node* head = nullptr;
public:
    void push_back(int v) {
        Node* n = new Node(v);
        if (!head) { head = n; return; }
        Node* cur = head;
        while (cur->next) cur = cur->next;
        cur->next = n;
    }
    int size() const {
        int c = 0;
        for (Node* cur = head; cur; cur = cur->next) ++c;
        return c;
    }
};
''', "qas": [
        ("What data structure does linked_list.cpp implement?", "A singly linked list."),
        ("Where does push_back insert new nodes in linked_list.cpp?", "At the tail (end) of the list."),
        ("What struct represents a single element in linked_list.cpp?", "The Node struct."),
    ]},

    {"name": "reverse_string.cpp", "code": '''// Reverse a string in place using two pointers.
#include <string>

void reverse_string(std::string& s) {
    int i = 0, j = (int)s.size() - 1;
    while (i < j) {
        std::swap(s[i], s[j]);
        ++i;
        --j;
    }
}
''', "qas": [
        ("What does reverse_string.cpp do?", "Reverses a string in place."),
        ("What technique does reverse_string.cpp use?", "Two pointers swapping from both ends."),
        ("Does reverse_string.cpp modify the string in place or return a copy?", "In place."),
    ]},

    {"name": "power.cpp", "code": '''// Fast exponentiation (exponentiation by squaring). Time complexity: O(log n).
long long power(long long base, long long exp) {
    long long result = 1;
    while (exp > 0) {
        if (exp & 1) result *= base;
        base *= base;
        exp >>= 1;
    }
    return result;
}
''', "qas": [
        ("Which technique does power.cpp use to compute exponents?", "Exponentiation by squaring (fast exponentiation)."),
        ("What is the time complexity of power.cpp?", "O(log n)."),
        ("What does power(2, 10) return?", "1024."),
    ]},

    {"name": "celsius_fahrenheit.cpp", "code": '''// Temperature conversion between Celsius and Fahrenheit.
double celsius_to_fahrenheit(double c) {
    return c * 9.0 / 5.0 + 32.0;
}

double fahrenheit_to_celsius(double f) {
    return (f - 32.0) * 5.0 / 9.0;
}
''', "qas": [
        ("What does celsius_fahrenheit.cpp convert between?", "Celsius and Fahrenheit."),
        ("What formula does celsius_to_fahrenheit use?", "c * 9/5 + 32."),
        ("What is 0 degrees Celsius in Fahrenheit per this file?", "32."),
    ]},

    {"name": "bank_account.cpp", "code": '''// Minimal bank account with deposit/withdraw and overdraft protection.
#include <stdexcept>

class BankAccount {
    double balance;
public:
    BankAccount(double initial = 0.0) : balance(initial) {}
    void deposit(double amount) {
        if (amount <= 0) throw std::invalid_argument("deposit must be positive");
        balance += amount;
    }
    void withdraw(double amount) {
        if (amount > balance) throw std::runtime_error("insufficient funds");
        balance -= amount;
    }
    double get_balance() const { return balance; }
};
''', "qas": [
        ("What class is defined in bank_account.cpp?", "The BankAccount class."),
        ("What does withdraw() throw when funds are insufficient?", "A std::runtime_error ('insufficient funds')."),
        ("What is the default initial balance of a BankAccount in bank_account.cpp?", "0.0."),
    ]},

    {"name": "matrix_transpose.cpp", "code": '''// Transpose a 2D matrix represented as a vector of vectors.
#include <vector>

std::vector<std::vector<int>> transpose(const std::vector<std::vector<int>>& m) {
    int rows = (int)m.size(), cols = (int)m[0].size();
    std::vector<std::vector<int>> t(cols, std::vector<int>(rows));
    for (int i = 0; i < rows; ++i)
        for (int j = 0; j < cols; ++j)
            t[j][i] = m[i][j];
    return t;
}
''', "qas": [
        ("What does matrix_transpose.cpp do?", "Transposes a 2D matrix."),
        ("How is the matrix represented in matrix_transpose.cpp?", "As a vector of vectors of int."),
        ("In the transpose function, what does t[j][i] get assigned?", "m[i][j]."),
    ]},
]

QUERIES = []
qid = 0
for f in FILES:
    with open(os.path.join(OUT, f["name"]), "w", encoding="utf-8") as fh:
        fh.write(f["code"])
    for q, a in f["qas"]:
        qid += 1
        QUERIES.append({"query_id": f"cpp_{qid:03d}", "question": q,
                        "reference_answer": a, "source_file": f["name"]})

pd.DataFrame(QUERIES).to_excel(os.path.join(OUT, "queries.xlsx"), index=False)
print(f"C++: wrote {len(FILES)} .cpp files + queries.xlsx ({len(QUERIES)} queries) -> {OUT}")
