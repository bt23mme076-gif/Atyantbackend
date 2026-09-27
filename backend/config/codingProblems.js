// Curated DSA problems for the live coding exercise. Kept as a fixed bank
// (not LLM-generated) so test cases are guaranteed correct and runnable —
// the planner injects one of these into the technical phase for a "tech"
// category interview instead of asking the model to invent code + tests.
//
// Each problem reads from stdin and writes to stdout so the same source
// runs unmodified through Piston for every supported language.

export const CODING_PROBLEMS = [
  {
    id: 'dsa_two_sum',
    title: 'Two Sum',
    difficulty: 2,
    topics: ['sde.dsa'],
    prompt: 'Read a line of space-separated integers (the array) and a second line with the target integer. Print the two 0-based indices whose values add up to the target, space-separated. Assume exactly one solution exists.',
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
    prompt: 'Read two lines, each a lowercase word. Print "true" if the second word is an anagram of the first, else print "false".',
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
    prompt: 'Read a line of space-separated integers. Print the largest possible sum of a contiguous subarray (at least one element).',
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
    prompt: 'Read one line of space-separated words. Print the words in reverse order, space-separated, with no extra spaces.',
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
