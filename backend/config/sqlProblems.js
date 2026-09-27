// Curated SQL exercises for the live coding panel. Fixed bank, not
// LLM-generated: `schema` seeds a fresh in-memory SQLite (both client-side
// via sql.js for instant feedback, and server-side via node:sqlite for the
// authoritative grade), and `checkQuery` is the reference solution the
// candidate's query is compared against.

export const SQL_PROBLEMS = [
  {
    id: 'sql_dept_avg_salary',
    title: 'Average salary by department',
    difficulty: 2,
    topics: ['data.sql', 'consultant.sql', 'sde.dbms'],
    prompt: 'Tables: departments(id, name) and employees(id, name, department_id, salary). Write a query that returns each department name with its average employee salary, highest average first.',
    schema: `
      CREATE TABLE departments (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT, department_id INTEGER, salary INTEGER);
      INSERT INTO departments VALUES (1,'Engineering'),(2,'Sales'),(3,'Marketing');
      INSERT INTO employees VALUES
        (1,'Asha',1,95000),(2,'Vikram',1,88000),(3,'Neha',2,60000),
        (4,'Raj',2,65000),(5,'Priya',3,55000);
    `,
    checkQuery: 'SELECT d.name, AVG(e.salary) FROM employees e JOIN departments d ON e.department_id = d.id GROUP BY d.name ORDER BY AVG(e.salary) DESC',
    orderMatters: true
  },
  {
    id: 'sql_second_highest',
    title: 'Second-highest salary',
    difficulty: 2,
    topics: ['data.sql', 'consultant.sql', 'sde.dbms'],
    prompt: 'Table: employees(id, name, salary). Write a query that returns the second-highest distinct salary. If there is no second-highest, return nothing.',
    schema: `
      CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT, salary INTEGER);
      INSERT INTO employees VALUES (1,'Asha',95000),(2,'Vikram',88000),(3,'Neha',95000),(4,'Raj',65000);
    `,
    checkQuery: 'SELECT DISTINCT salary FROM employees ORDER BY salary DESC LIMIT 1 OFFSET 1',
    orderMatters: false
  },
  {
    id: 'sql_customers_no_orders',
    title: 'Customers with no orders',
    difficulty: 3,
    topics: ['data.sql', 'consultant.sql', 'sde.dbms'],
    prompt: 'Tables: customers(id, name) and orders(id, customer_id, amount). Write a query that returns the names of customers who have placed zero orders.',
    schema: `
      CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, amount INTEGER);
      INSERT INTO customers VALUES (1,'Amit'),(2,'Bela'),(3,'Chirag'),(4,'Divya');
      INSERT INTO orders VALUES (1,1,500),(2,1,300),(3,3,900);
    `,
    checkQuery: 'SELECT c.name FROM customers c LEFT JOIN orders o ON o.customer_id = c.id WHERE o.id IS NULL',
    orderMatters: false
  }
];

export function pickSqlProblem({ difficulty, excludeIds = [] } = {}) {
  const pool = SQL_PROBLEMS.filter(p => !excludeIds.includes(p.id));
  if (!pool.length) return null;
  if (difficulty == null) return pool[0];
  return [...pool].sort((a, b) => Math.abs(a.difficulty - difficulty) - Math.abs(b.difficulty - difficulty))[0];
}

export function getSqlProblem(id) {
  return SQL_PROBLEMS.find(p => p.id === id) || null;
}
