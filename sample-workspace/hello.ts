/**
 * Sample TypeScript file for testing SHE v2 agent.
 * This workspace demonstrates file reading, editing, and KB ingestion.
 */

interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user' | 'guest';
}

function greet(user: User): string {
  const greeting = user.role === 'admin'
    ? `Welcome back, ${user.name}. You have full access.`
    : `Hello, ${user.name}!`;

  return greeting;
}

function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const sampleUsers: User[] = [
  { id: '1', name: 'Alice', email: 'alice@example.com', role: 'admin' },
  { id: '2', name: 'Bob', email: 'bob@example.com', role: 'user' },
];

for (const user of sampleUsers) {
  console.log(greet(user));
}

export { greet, validateEmail };
export type { User };
