# Issue #006: Redundant Child Iteration in `findNode` Tree Search

- **Status**: Resolved
- **Type**: Performance / Code Quality
- **Severity**: Low
- **Component**: [`tree.ts`](file:///home/jhonny/Sources/pi-navigator/tree.ts) / [`findNode`](file:///home/jhonny/Sources/pi-navigator/tree.ts#L316-L328)

---

## Description

The [`findNode`](file:///home/jhonny/Sources/pi-navigator/tree.ts#L316-L328) utility function traverses the file tree using [`walkTree`](file:///home/jhonny/Sources/pi-navigator/tree.ts#L260-L268). However, inside the `visit` callback for each visited node, it iterates over `node.children`, checking each child's `relPath`.

Because [`walkTree`](file:///home/jhonny/Sources/pi-navigator/tree.ts#L260-L268) is a depth-first search that pushes all children of every node onto the stack, every child node is examined twice:
1. Once inside the `node.children` loop of its parent.
2. Once when the child itself is popped from the stack and passed into `visit`.

---

## Code References

- [`tree.ts:260-268` (`walkTree`)](file:///home/jhonny/Sources/pi-navigator/tree.ts#L260-L268):
  ```typescript
  export function walkTree(root: FileNode, visit: (node: FileNode) => boolean | void): void {
    const stack: FileNode[] = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      if (visit(node) === false) return;
      for (const child of node.children) stack.push(child);
    }
  }
  ```
- [`tree.ts:316-328` (`findNode`)](file:///home/jhonny/Sources/pi-navigator/tree.ts#L316-L328):
  ```typescript
  export function findNode(root: FileNode, relPath: string): FileNode | null {
    if (relPath === "") return root;
    let found: FileNode | null = null;
    walkTree(root, (node) => {
      for (const child of node.children) {
        if (child.relPath === relPath) {
          found = child;
          return false;
        }
      }
    });
    return found;
  }
  ```

---

## Potential Solution

Simplify `findNode` by checking `node.relPath === relPath` directly on the visited node:

```typescript
export function findNode(root: FileNode, relPath: string): FileNode | null {
  if (relPath === "") return root;
  let found: FileNode | null = null;
  walkTree(root, (node) => {
    if (node.relPath === relPath) {
      found = node;
      return false;
    }
  });
  return found;
}
```

This reduces the number of equality checks by roughly half and simplifies the traversal logic.

---

## Acceptance Criteria

- [x] `findNode` checks each node exactly once.
- [x] All tree unit tests in [`test/tree.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/tree.test.ts) continue to pass.
