// Curated DSA problems for the live coding exercise. Kept as a fixed bank
// (not LLM-generated) so test cases are guaranteed correct and runnable —
// the planner injects one of these into the technical phase for a "tech"
// category interview instead of asking the model to invent code + tests.
//
// Each problem reads from stdin and writes to stdout so the same source
// runs unmodified through Piston for every supported language. `examples`
// and `constraints` are display-only (LeetCode-style problem panel) — the
// actual grading only ever looks at `tests`.

export const CODING_PROBLEMS = [
  {
    id: 'dsa_two_sum',
    title: 'Two Sum',
    difficulty: 2,
    topics: ['sde.dsa'],
    prompt: 'Given an array of integers and a target, return the indices of the two numbers that add up to the target.',
    ioNote: 'Read a line of space-separated integers (the array), then a line with the target. Print the two 0-based indices, space-separated. Assume exactly one solution exists.',
    examples: [
      { input: 'nums = [2,7,11,15], target = 9', output: '[0,1]', explanation: 'nums[0] + nums[1] = 2 + 7 = 9.' },
      { input: 'nums = [3,2,4], target = 6', output: '[1,2]' }
    ],
    constraints: ['2 <= nums.length <= 1000', '-1000 <= nums[i] <= 1000', 'Exactly one valid answer exists.'],
    starter: {
      javascript: 'const lines = require("fs").readFileSync(0, "utf8").split("\\n");\nconst nums = lines[0].trim().split(/\\s+/).map(Number);\nconst target = Number(lines[1]);\n\n// write your solution, then print the two indices space-separated\n',
      python: 'import sys\nlines = sys.stdin.read().split("\\n")\nnums = list(map(int, lines[0].split()))\ntarget = int(lines[1])\n\n# write your solution, then print the two indices space-separated\n',
      cpp: '#include <bits/stdc++.h>\nusing namespace std;\nint main(){\n  string line; getline(cin, line);\n  istringstream iss(line); vector<long long> nums; long long x;\n  while (iss >> x) nums.push_back(x);\n  long long target; cin >> target;\n  // write your solution, then print the two indices space-separated\n  return 0;\n}\n',
      java: 'import java.util.*;\npublic class Main {\n  public static void main(String[] args) {\n    Scanner sc = new Scanner(System.in);\n    String[] parts = sc.nextLine().trim().split("\\\\s+");\n    int[] nums = new int[parts.length];\n    for (int i = 0; i < parts.length; i++) nums[i] = Integer.parseInt(parts[i]);\n    int target = Integer.parseInt(sc.nextLine().trim());\n    // write your solution, then print the two indices space-separated\n  }\n}\n'
    },
    tests: [
      { input: '2 7 11 15\n9', expected: '0 1' },
      { input: '3 2 4\n6', expected: '1 2' },
      { input: '1 2 3 4 5\n9', expected: '3 4' },
      { input: '3 3\n6', expected: '0 1', hidden: true },
      { input: '-1 -2 -3 -4 -5\n-8', expected: '2 4', hidden: true }
    ]
  },
  {
    id: 'dsa_valid_anagram',
    title: 'Valid Anagram',
    difficulty: 1,
    topics: ['sde.dsa'],
    prompt: 'Given two strings, determine whether the second is an anagram of the first.',
    ioNote: 'Read two lines, each a lowercase word. Print "true" if the second word is an anagram of the first, else print "false".',
    examples: [
      { input: 's = "anagram", t = "nagaram"', output: 'true' },
      { input: 's = "rat", t = "car"', output: 'false' }
    ],
    constraints: ['1 <= s.length, t.length <= 5*10^4', 's and t consist of lowercase English letters.'],
    starter: {
      javascript: 'const lines = require("fs").readFileSync(0, "utf8").split("\\n");\nconst a = lines[0].trim();\nconst b = lines[1].trim();\n\n// write your solution, then print true or false\n',
      python: 'import sys\nlines = sys.stdin.read().split("\\n")\na = lines[0].strip()\nb = lines[1].strip()\n\n# write your solution, then print true or false\n',
      cpp: '#include <bits/stdc++.h>\nusing namespace std;\nint main(){\n  string a, b; getline(cin, a); getline(cin, b);\n  // write your solution, then print true or false\n  return 0;\n}\n',
      java: 'import java.util.*;\npublic class Main {\n  public static void main(String[] args) {\n    Scanner sc = new Scanner(System.in);\n    String a = sc.nextLine().trim();\n    String b = sc.nextLine().trim();\n    // write your solution, then print true or false\n  }\n}\n'
    },
    tests: [
      { input: 'listen\nsilent', expected: 'true' },
      { input: 'rat\ncar', expected: 'false' },
      { input: 'anagram\nnagaram', expected: 'true' },
      { input: 'ab\nab', expected: 'true', hidden: true },
      { input: 'ab\nba', expected: 'true', hidden: true }
    ]
  },
  {
    id: 'dsa_max_subarray',
    title: 'Maximum Subarray Sum',
    difficulty: 3,
    topics: ['sde.dsa'],
    prompt: 'Given an integer array, find the contiguous subarray (containing at least one number) with the largest sum, and return its sum.',
    ioNote: 'Read a line of space-separated integers. Print the largest possible sum of a contiguous subarray.',
    examples: [
      { input: 'nums = [-2,1,-3,4,-1,2,1,-5,4]', output: '6', explanation: '[4,-1,2,1] has the largest sum = 6.' },
      { input: 'nums = [1]', output: '1' }
    ],
    constraints: ['1 <= nums.length <= 10^5', '-10^4 <= nums[i] <= 10^4'],
    starter: {
      javascript: 'const nums = require("fs").readFileSync(0, "utf8").trim().split(/\\s+/).map(Number);\n\n// write your solution, then print the max subarray sum\n',
      python: 'import sys\nnums = list(map(int, sys.stdin.read().strip().split()))\n\n# write your solution, then print the max subarray sum\n',
      cpp: '#include <bits/stdc++.h>\nusing namespace std;\nint main(){\n  vector<long long> nums; long long x;\n  while (cin >> x) nums.push_back(x);\n  // write your solution, then print the max subarray sum\n  return 0;\n}\n',
      java: 'import java.util.*;\npublic class Main {\n  public static void main(String[] args) {\n    Scanner sc = new Scanner(System.in);\n    List<Long> nums = new ArrayList<>();\n    while (sc.hasNextLong()) nums.add(sc.nextLong());\n    // write your solution, then print the max subarray sum\n  }\n}\n'
    },
    tests: [
      { input: '-2 1 -3 4 -1 2 1 -5 4', expected: '6' },
      { input: '1', expected: '1' },
      { input: '5 4 -1 7 8', expected: '23' },
      { input: '-1 -2 -3', expected: '-1', hidden: true },
      { input: '-5', expected: '-5', hidden: true }
    ]
  },
  {
    id: 'dsa_reverse_words',
    title: 'Reverse Words in a Sentence',
    difficulty: 2,
    topics: ['sde.dsa'],
    prompt: 'Given a sentence, return the words in reverse order.',
    ioNote: 'Read one line of space-separated words. Print the words in reverse order, space-separated, with no extra spaces.',
    examples: [
      { input: 's = "the sky is blue"', output: '"blue is sky the"' },
      { input: 's = "hello world"', output: '"world hello"' }
    ],
    constraints: ['1 <= s.length <= 10^4', 's contains only lowercase letters and single spaces between words.'],
    starter: {
      javascript: 'const line = require("fs").readFileSync(0, "utf8").trim();\n\n// write your solution, then print the reversed sentence\n',
      python: 'import sys\nline = sys.stdin.read().strip()\n\n# write your solution, then print the reversed sentence\n',
      cpp: '#include <bits/stdc++.h>\nusing namespace std;\nint main(){\n  string word; vector<string> words;\n  while (cin >> word) words.push_back(word);\n  // write your solution, then print the reversed sentence\n  return 0;\n}\n',
      java: 'import java.util.*;\npublic class Main {\n  public static void main(String[] args) {\n    Scanner sc = new Scanner(System.in);\n    List<String> words = new ArrayList<>();\n    while (sc.hasNext()) words.add(sc.next());\n    // write your solution, then print the reversed sentence\n  }\n}\n'
    },
    tests: [
      { input: 'the sky is blue', expected: 'blue is sky the' },
      { input: 'hello world', expected: 'world hello' },
      { input: 'a b c d', expected: 'd c b a', hidden: true }
    ]
  },
  {
    id: 'dsa_add_two_numbers',
    title: 'Add Two Numbers',
    difficulty: 3,
    topics: ['sde.dsa'],
    prompt: 'You are given two non-empty linked lists representing two non-negative integers. The digits are stored in reverse order, and each node contains a single digit. Add the two numbers and return the sum as a linked list, also in reverse order.',
    ioNote: 'Read two lines, each the space-separated digits of a number in reverse order (so "2 4 3" means 342). Print the sum\'s digits, space-separated, also in reverse order. Starter code already builds the linked lists for you and prints your result — just fill in the function.',
    examples: [
      { input: 'l1 = [2,4,3], l2 = [5,6,4]', output: '[7,0,8]', explanation: '342 + 465 = 807.' },
      { input: 'l1 = [0], l2 = [0]', output: '[0]' },
      { input: 'l1 = [9,9,9,9,9,9,9], l2 = [9,9,9,9]', output: '[8,9,9,9,0,0,0,1]' }
    ],
    constraints: ['The number of nodes in each list is in [1, 100].', '0 <= Node.val <= 9', 'No leading zeros except the number 0 itself.'],
    starter: {
      javascript: 'const lines = require("fs").readFileSync(0, "utf8").split("\\n");\nclass ListNode { constructor(val, next = null) { this.val = val; this.next = next; } }\nfunction buildList(arr) { const dummy = new ListNode(0); let cur = dummy; for (const v of arr) { cur.next = new ListNode(v); cur = cur.next; } return dummy.next; }\nfunction printList(node) { const out = []; while (node) { out.push(node.val); node = node.next; } console.log(out.join(" ")); }\n\nconst l1 = buildList(lines[0].trim().split(/\\s+/).map(Number));\nconst l2 = buildList(lines[1].trim().split(/\\s+/).map(Number));\n\nfunction addTwoNumbers(l1, l2) {\n  // write your solution here, return the head of the resulting list\n}\n\nprintList(addTwoNumbers(l1, l2));\n',
      python: 'import sys\nlines = sys.stdin.read().split("\\n")\n\nclass ListNode:\n    def __init__(self, val=0, next=None):\n        self.val = val\n        self.next = next\n\ndef build_list(arr):\n    dummy = ListNode()\n    cur = dummy\n    for v in arr:\n        cur.next = ListNode(v)\n        cur = cur.next\n    return dummy.next\n\ndef print_list(node):\n    out = []\n    while node:\n        out.append(str(node.val))\n        node = node.next\n    print(" ".join(out))\n\nl1 = build_list(list(map(int, lines[0].split())))\nl2 = build_list(list(map(int, lines[1].split())))\n\ndef add_two_numbers(l1, l2):\n    # write your solution here, return the head of the resulting list\n    pass\n\nprint_list(add_two_numbers(l1, l2))\n',
      cpp: '#include <bits/stdc++.h>\nusing namespace std;\nstruct ListNode { int val; ListNode* next; ListNode(int v): val(v), next(nullptr) {} };\nListNode* buildList(vector<int>& arr) { ListNode dummy(0); ListNode* cur = &dummy; for (int v : arr) { cur->next = new ListNode(v); cur = cur->next; } return dummy.next; }\nvoid printList(ListNode* node) { vector<int> out; while (node) { out.push_back(node->val); node = node->next; } for (size_t i = 0; i < out.size(); i++) cout << out[i] << (i + 1 < out.size() ? " " : "\\n"); if (out.empty()) cout << "\\n"; }\n\nListNode* addTwoNumbers(ListNode* l1, ListNode* l2) {\n  // write your solution here, return the head of the resulting list\n  return nullptr;\n}\n\nint main(){\n  string line1, line2; getline(cin, line1); getline(cin, line2);\n  istringstream iss1(line1), iss2(line2); vector<int> a, b; int x;\n  while (iss1 >> x) a.push_back(x);\n  while (iss2 >> x) b.push_back(x);\n  ListNode* l1 = buildList(a); ListNode* l2 = buildList(b);\n  printList(addTwoNumbers(l1, l2));\n  return 0;\n}\n',
      java: 'import java.util.*;\npublic class Main {\n  static class ListNode { int val; ListNode next; ListNode(int v) { val = v; } }\n  static ListNode buildList(int[] arr) { ListNode dummy = new ListNode(0), cur = dummy; for (int v : arr) { cur.next = new ListNode(v); cur = cur.next; } return dummy.next; }\n  static void printList(ListNode node) { List<String> out = new ArrayList<>(); while (node != null) { out.add(String.valueOf(node.val)); node = node.next; } System.out.println(String.join(" ", out)); }\n  static ListNode addTwoNumbers(ListNode l1, ListNode l2) {\n    // write your solution here, return the head of the resulting list\n    return null;\n  }\n  public static void main(String[] args) {\n    Scanner sc = new Scanner(System.in);\n    int[] a = Arrays.stream(sc.nextLine().trim().split("\\\\s+")).mapToInt(Integer::parseInt).toArray();\n    int[] b = Arrays.stream(sc.nextLine().trim().split("\\\\s+")).mapToInt(Integer::parseInt).toArray();\n    printList(addTwoNumbers(buildList(a), buildList(b)));\n  }\n}\n'
    },
    tests: [
      { input: '2 4 3\n5 6 4', expected: '7 0 8' },
      { input: '0\n0', expected: '0' },
      { input: '9 9 9 9 9 9 9\n9 9 9 9', expected: '8 9 9 9 0 0 0 1', hidden: true }
    ]
  },
  {
    id: 'dsa_merge_k_lists',
    title: 'Merge k Sorted Lists',
    difficulty: 4,
    topics: ['sde.dsa'],
    prompt: 'You are given an array of k linked-lists, each sorted in ascending order. Merge all the linked-lists into one sorted linked list and return it.',
    ioNote: 'Read a line with k, then k lines each a space-separated sorted list (a blank line means that list is empty). Print the fully merged list, space-separated (a blank line if the result is empty). Starter code already builds and prints the lists — just fill in the function.',
    examples: [
      { input: 'lists = [[1,4,5],[1,3,4],[2,6]]', output: '[1,1,2,3,4,4,5,6]' },
      { input: 'lists = []', output: '[]' },
      { input: 'lists = [[]]', output: '[]' }
    ],
    constraints: ['0 <= k <= 10^4', '0 <= lists[i].length <= 500', 'Each lists[i] is sorted in ascending order.'],
    starter: {
      javascript: 'const lines = require("fs").readFileSync(0, "utf8").split("\\n");\nclass ListNode { constructor(val, next = null) { this.val = val; this.next = next; } }\nfunction buildList(arr) { const dummy = new ListNode(0); let cur = dummy; for (const v of arr) { cur.next = new ListNode(v); cur = cur.next; } return dummy.next; }\nfunction printList(node) { const out = []; while (node) { out.push(node.val); node = node.next; } console.log(out.join(" ")); }\n\nconst k = Number(lines[0].trim());\nconst lists = [];\nfor (let i = 0; i < k; i++) {\n  const raw = (lines[i + 1] || "").trim();\n  lists.push(buildList(raw ? raw.split(/\\s+/).map(Number) : []));\n}\n\nfunction mergeKLists(lists) {\n  // write your solution here, return the head of the merged list\n}\n\nprintList(mergeKLists(lists));\n',
      python: 'import sys\nlines = sys.stdin.read().split("\\n")\n\nclass ListNode:\n    def __init__(self, val=0, next=None):\n        self.val = val\n        self.next = next\n\ndef build_list(arr):\n    dummy = ListNode()\n    cur = dummy\n    for v in arr:\n        cur.next = ListNode(v)\n        cur = cur.next\n    return dummy.next\n\ndef print_list(node):\n    out = []\n    while node:\n        out.append(str(node.val))\n        node = node.next\n    print(" ".join(out))\n\nk = int(lines[0].strip() or 0)\nlists = []\nfor i in range(k):\n    raw = lines[i + 1].strip() if i + 1 < len(lines) else ""\n    lists.append(build_list(list(map(int, raw.split())) if raw else []))\n\ndef merge_k_lists(lists):\n    # write your solution here, return the head of the merged list\n    pass\n\nprint_list(merge_k_lists(lists))\n',
      cpp: '#include <bits/stdc++.h>\nusing namespace std;\nstruct ListNode { int val; ListNode* next; ListNode(int v): val(v), next(nullptr) {} };\nListNode* buildList(vector<int>& arr) { ListNode dummy(0); ListNode* cur = &dummy; for (int v : arr) { cur->next = new ListNode(v); cur = cur->next; } return dummy.next; }\nvoid printList(ListNode* node) { vector<int> out; while (node) { out.push_back(node->val); node = node->next; } for (size_t i = 0; i < out.size(); i++) cout << out[i] << (i + 1 < out.size() ? " " : ""); cout << "\\n"; }\n\nListNode* mergeKLists(vector<ListNode*>& lists) {\n  // write your solution here, return the head of the merged list\n  return nullptr;\n}\n\nint main(){\n  int k; cin >> k; cin.ignore();\n  vector<ListNode*> lists;\n  for (int i = 0; i < k; i++) {\n    string line; getline(cin, line);\n    istringstream iss(line); vector<int> a; int x;\n    while (iss >> x) a.push_back(x);\n    lists.push_back(buildList(a));\n  }\n  printList(mergeKLists(lists));\n  return 0;\n}\n',
      java: 'import java.util.*;\npublic class Main {\n  static class ListNode { int val; ListNode next; ListNode(int v) { val = v; } }\n  static ListNode buildList(int[] arr) { ListNode dummy = new ListNode(0), cur = dummy; for (int v : arr) { cur.next = new ListNode(v); cur = cur.next; } return dummy.next; }\n  static void printList(ListNode node) { List<String> out = new ArrayList<>(); while (node != null) { out.add(String.valueOf(node.val)); node = node.next; } System.out.println(String.join(" ", out)); }\n  static ListNode mergeKLists(List<ListNode> lists) {\n    // write your solution here, return the head of the merged list\n    return null;\n  }\n  public static void main(String[] args) {\n    Scanner sc = new Scanner(System.in);\n    int k = Integer.parseInt(sc.nextLine().trim());\n    List<ListNode> lists = new ArrayList<>();\n    for (int i = 0; i < k; i++) {\n      String raw = sc.hasNextLine() ? sc.nextLine().trim() : "";\n      int[] arr = raw.isEmpty() ? new int[0] : Arrays.stream(raw.split("\\\\s+")).mapToInt(Integer::parseInt).toArray();\n      lists.add(buildList(arr));\n    }\n    printList(mergeKLists(lists));\n  }\n}\n'
    },
    tests: [
      { input: '3\n1 4 5\n1 3 4\n2 6', expected: '1 1 2 3 4 4 5 6' },
      { input: '0', expected: '' },
      { input: '1\n', expected: '', hidden: true }
    ]
  }
];

export function pickCodingProblem({ difficulty, excludeIds = [] } = {}) {
  const pool = CODING_PROBLEMS.filter(p => !excludeIds.includes(p.id));
  if (!pool.length) return null;
  if (difficulty == null) return pool[0];
  return [...pool].sort((a, b) => Math.abs(a.difficulty - difficulty) - Math.abs(b.difficulty - difficulty))[0];
}

export function getCodingProblem(id) {
  return CODING_PROBLEMS.find(p => p.id === id) || null;
}
