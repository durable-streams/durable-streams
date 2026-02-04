/**
 * Dancing Links (DLX) implementation of Knuth's Algorithm X
 * for solving exact cover problems with colored constraints.
 *
 * This is used for crossword puzzle generation where:
 * - Primary constraints: each word slot must be filled
 * - Secondary constraints with colors: cells can be shared if letters match
 */

export interface DLXNode {
  left: DLXNode;
  right: DLXNode;
  up: DLXNode;
  down: DLXNode;
  column: ColumnNode;
  rowId: number;
  color?: string; // For colored constraints (letter at position)
}

export interface ColumnNode extends DLXNode {
  size: number;
  name: string;
  isPrimary: boolean;
}

export class DancingLinks {
  private header: ColumnNode;
  private columns: Map<string, ColumnNode> = new Map();
  private solution: number[] = [];
  private solutions: number[][] = [];
  private maxSolutions: number;
  private nodeCount = 0;

  constructor(maxSolutions = 1) {
    this.maxSolutions = maxSolutions;
    this.header = this.createColumnNode('header', true);
    this.header.left = this.header;
    this.header.right = this.header;
  }

  private createNode(): DLXNode {
    this.nodeCount++;
    const node = {} as DLXNode;
    node.left = node;
    node.right = node;
    node.up = node;
    node.down = node;
    node.rowId = -1;
    return node;
  }

  private createColumnNode(name: string, isPrimary: boolean): ColumnNode {
    const node = this.createNode() as ColumnNode;
    node.column = node;
    node.size = 0;
    node.name = name;
    node.isPrimary = isPrimary;
    return node;
  }

  addColumn(name: string, isPrimary = true): void {
    if (this.columns.has(name)) return;

    const column = this.createColumnNode(name, isPrimary);
    this.columns.set(name, column);

    // Insert before header (at end of list)
    column.right = this.header;
    column.left = this.header.left;
    this.header.left.right = column;
    this.header.left = column;
  }

  addRow(rowId: number, constraints: Array<{ column: string; color?: string }>): void {
    let firstNode: DLXNode | null = null;
    let prevNode: DLXNode | null = null;

    for (const constraint of constraints) {
      const column = this.columns.get(constraint.column);
      if (!column) {
        throw new Error(`Column ${constraint.column} not found`);
      }

      const node = this.createNode();
      node.column = column;
      node.rowId = rowId;
      node.color = constraint.color;

      // Insert at bottom of column
      node.down = column;
      node.up = column.up;
      column.up.down = node;
      column.up = node;
      column.size++;

      // Link horizontally
      if (!firstNode) {
        firstNode = node;
        node.left = node;
        node.right = node;
      } else {
        node.right = firstNode;
        node.left = prevNode!;
        prevNode!.right = node;
        firstNode.left = node;
      }
      prevNode = node;
    }
  }

  private cover(column: ColumnNode): void {
    // Remove column from header list
    column.right.left = column.left;
    column.left.right = column.right;

    // Remove all rows that have a 1 in this column
    for (let row = column.down; row !== column; row = row.down) {
      for (let node = row.right; node !== row; node = node.right) {
        node.down.up = node.up;
        node.up.down = node.down;
        node.column.size--;
      }
    }
  }

  private uncover(column: ColumnNode): void {
    // Restore all rows that have a 1 in this column (in reverse order)
    for (let row = column.up; row !== column; row = row.up) {
      for (let node = row.left; node !== row; node = node.left) {
        node.column.size++;
        node.down.up = node;
        node.up.down = node;
      }
    }

    // Restore column to header list
    column.right.left = column;
    column.left.right = column;
  }

  private coverWithColor(column: ColumnNode, color: string): void {
    // For colored constraints, only cover rows with different colors
    for (let row = column.down; row !== column; row = row.down) {
      if (row.color !== color) {
        for (let node = row.right; node !== row; node = node.right) {
          node.down.up = node.up;
          node.up.down = node.down;
          node.column.size--;
        }
      }
    }
  }

  private uncoverWithColor(column: ColumnNode, color: string): void {
    for (let row = column.up; row !== column; row = row.up) {
      if (row.color !== color) {
        for (let node = row.left; node !== row; node = node.left) {
          node.column.size++;
          node.down.up = node;
          node.up.down = node;
        }
      }
    }
  }

  private selectColumn(): ColumnNode | null {
    // S heuristic: choose column with minimum size (MRV)
    let minSize = Infinity;
    let chosen: ColumnNode | null = null;

    for (let col = this.header.right as ColumnNode; col !== this.header; col = col.right as ColumnNode) {
      if (col.isPrimary && col.size < minSize) {
        minSize = col.size;
        chosen = col;
        if (minSize === 0) break; // Can't do better than 0
      }
    }

    return chosen;
  }

  private search(depth: number): boolean {
    // Check if we found a solution (no more primary columns)
    let hasPrimary = false;
    for (let col = this.header.right as ColumnNode; col !== this.header; col = col.right as ColumnNode) {
      if (col.isPrimary) {
        hasPrimary = true;
        break;
      }
    }

    if (!hasPrimary) {
      this.solutions.push([...this.solution]);
      return this.solutions.length >= this.maxSolutions;
    }

    const column = this.selectColumn();
    if (!column || column.size === 0) {
      return false; // Dead end
    }

    this.cover(column);

    for (let row = column.down; row !== column; row = row.down) {
      this.solution[depth] = row.rowId;

      // Cover columns and handle colored constraints
      const coveredColumns: Array<{ col: ColumnNode; color?: string }> = [];

      for (let node = row.right; node !== row; node = node.right) {
        if (node.column.isPrimary) {
          this.cover(node.column);
          coveredColumns.push({ col: node.column });
        } else if (node.color) {
          this.coverWithColor(node.column, node.color);
          coveredColumns.push({ col: node.column, color: node.color });
        }
      }

      if (this.search(depth + 1)) {
        return true;
      }

      // Uncover in reverse order
      for (let i = coveredColumns.length - 1; i >= 0; i--) {
        const { col, color } = coveredColumns[i];
        if (color) {
          this.uncoverWithColor(col, color);
        } else {
          this.uncover(col);
        }
      }
    }

    this.uncover(column);
    return false;
  }

  solve(): number[][] {
    this.solutions = [];
    this.solution = [];
    this.search(0);
    return this.solutions;
  }

  getSolutionCount(): number {
    return this.solutions.length;
  }

  getNodeCount(): number {
    return this.nodeCount;
  }
}

/**
 * Crossword-specific DLX solver
 * Models crossword as exact cover with colored secondary constraints
 */
export interface WordPlacement {
  id: number;
  word: string;
  clue: string;
  x: number;
  y: number;
  direction: 'across' | 'down';
  slotId: string;
}

export interface CrosswordSlot {
  id: string;
  x: number;
  y: number;
  length: number;
  direction: 'across' | 'down';
}

export class CrosswordDLX {
  private dlx: DancingLinks;
  private placements: WordPlacement[] = [];

  constructor() {
    this.dlx = new DancingLinks(1);
  }

  /**
   * Set up the DLX matrix for crossword solving
   * @param slots - Available word slots in the grid
   * @param words - Dictionary of words with clues
   */
  setup(
    slots: CrosswordSlot[],
    words: Map<string, string> // word -> clue
  ): void {
    this.placements = [];

    // Add primary columns for each slot (must be filled exactly once)
    for (const slot of slots) {
      this.dlx.addColumn(`slot:${slot.id}`, true);
    }

    // Add secondary columns for each cell (can be covered multiple times with same letter)
    const cells = new Set<string>();
    for (const slot of slots) {
      for (let i = 0; i < slot.length; i++) {
        const x = slot.direction === 'across' ? slot.x + i : slot.x;
        const y = slot.direction === 'down' ? slot.y + i : slot.y;
        cells.add(`cell:${x},${y}`);
      }
    }
    for (const cell of cells) {
      this.dlx.addColumn(cell, false); // Secondary constraint
    }

    // Add rows for each possible word placement
    let rowId = 0;
    for (const slot of slots) {
      for (const [word, clue] of words) {
        if (word.length !== slot.length) continue;

        const constraints: Array<{ column: string; color?: string }> = [];

        // Primary constraint: this slot is filled
        constraints.push({ column: `slot:${slot.id}` });

        // Secondary constraints: each cell gets this letter
        for (let i = 0; i < word.length; i++) {
          const x = slot.direction === 'across' ? slot.x + i : slot.x;
          const y = slot.direction === 'down' ? slot.y + i : slot.y;
          constraints.push({
            column: `cell:${x},${y}`,
            color: word[i].toUpperCase()
          });
        }

        this.placements.push({
          id: rowId,
          word: word.toUpperCase(),
          clue,
          x: slot.x,
          y: slot.y,
          direction: slot.direction,
          slotId: slot.id
        });

        this.dlx.addRow(rowId, constraints);
        rowId++;
      }
    }
  }

  solve(): WordPlacement[] | null {
    const solutions = this.dlx.solve();
    if (solutions.length === 0) return null;

    const rowIds = solutions[0];
    return rowIds.map(id => this.placements[id]);
  }
}
