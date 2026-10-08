/** @fileoverview Bounded broad-phase filtering shared by topology checks. */
import { fail, collectionBudget, chargeCollection } from './common.js';

export function budget(ctx, path = '$', relatedPath) {
  chargeCollection(ctx?.[collectionBudget], 'topologyChecks', 1);
  if (ctx && ++ctx.topologyChecks > ctx.maxTopologyChecks)
    fail(
      'LIMIT',
      `topology comparison limit exceeded; increase maxTopologyChecks explicitly${relatedPath ? ` (compared with ${relatedPath})` : ''}`,
      path,
    );
}
export function bounds(points) {
  let xmin = Infinity,
    ymin = Infinity,
    xmax = -Infinity,
    ymax = -Infinity;
  for (const [x, y] of points) {
    xmin = Math.min(xmin, x);
    xmax = Math.max(xmax, x);
    ymin = Math.min(ymin, y);
    ymax = Math.max(ymax, y);
  }
  return { xmin, ymin, xmax, ymax };
}
export const intersects = (a, b) =>
  a.xmin <= b.xmax && a.xmax >= b.xmin && a.ymin <= b.ymax && a.ymax >= b.ymin;

// AVL interval index for the other axis. Subtree maxima prune disjoint ranges;
// balancing bounds update/search depth even for sorted or vertically aligned input.
const height = (n) => n?.height ?? 0;
function update(n) {
  n.height = 1 + Math.max(height(n.left), height(n.right));
  n.max = Math.max(n.item.upper, n.left?.max ?? -Infinity, n.right?.max ?? -Infinity);
  return n;
}
function rotate(n, side) {
  const other = side === 'left' ? 'right' : 'left';
  const root = n[other];
  n[other] = root[side];
  root[side] = update(n);
  return update(root);
}
function balance(n) {
  update(n);
  if (height(n.left) - height(n.right) > 1) {
    if (height(n.left.left) < height(n.left.right)) n.left = rotate(n.left, 'left');
    return rotate(n, 'right');
  }
  if (height(n.right) - height(n.left) > 1) {
    if (height(n.right.right) < height(n.right.left))
      n.right = rotate(n.right, 'right');
    return rotate(n, 'left');
  }
  return n;
}
const compare = (a, b) => a.lower - b.lower || a.index - b.index;
function insert(n, item) {
  if (!n) return { item, max: item.upper, height: 1, left: null, right: null };
  const side = compare(item, n.item) < 0 ? 'left' : 'right';
  n[side] = insert(n[side], item);
  return balance(n);
}
function remove(n, item) {
  if (!n) return null;
  const order = compare(item, n.item);
  if (order !== 0) {
    const side = order < 0 ? 'left' : 'right';
    n[side] = remove(n[side], item);
  } else {
    if (!n.left || !n.right) return n.left ?? n.right;
    let next = n.right;
    while (next.left) next = next.left;
    n.item = next.item;
    n.right = remove(n.right, next.item);
  }
  return balance(n);
}
function* query(root, low, high, ctx, path, relatedPath) {
  const pending = root ? [root] : [];
  while (pending.length) {
    const n = pending.pop();
    budget(ctx, path, relatedPath);
    if (n.max < low) continue;
    if (n.left && n.left.max >= low) pending.push(n.left);
    if (n.item.lower > high) continue;
    if (n.item.upper >= low) yield n.item;
    if (n.right && n.right.max >= low) pending.push(n.right);
  }
}
/** Immutable interval index, also used for point-in-ring boundary/ray queries. */
export function intervalIndex(items, lower, upper) {
  let root = null;
  for (let i = 0; i < items.length; i++)
    root = insert(root, {
      ...items[i],
      index: i,
      lower: lower(items[i]),
      upper: upper(items[i]),
    });
  return (low, high, ctx, path, relatedPath) =>
    query(root, low, high, ctx, path, relatedPath);
}

/** Sweep the longer axis; an end-event queue expires boxes without scanning active sets. */
export function* candidatePairs(
  items,
  ctx,
  path = '$',
  crossGroupsOnly = false,
  relatedPath,
) {
  const extent = bounds(
    items.flatMap(({ box }) => [
      [box.xmin, box.ymin],
      [box.xmax, box.ymax],
    ]),
  );
  const axis = extent.ymax - extent.ymin > extent.xmax - extent.xmin ? 'y' : 'x';
  const min = `${axis}min`,
    max = `${axis}max`;
  const secondary = axis === 'x' ? 'y' : 'x';
  const sorted = items
    .map((item, i) => ({
      ...item,
      index: i,
      lower: item.box[`${secondary}min`],
      upper: item.box[`${secondary}max`],
    }))
    .sort((a, b) => a.box[min] - b.box[min] || a.index - b.index);
  const ends = [...sorted].sort((a, b) => a.box[max] - b.box[max] || a.index - b.index);
  const groups = new Map();
  const treeKey = (item) => (crossGroupsOnly ? item.group : 0);
  let expired = 0;
  for (const item of sorted) {
    while (expired < ends.length && ends[expired].box[max] < item.box[min]) {
      const other = ends[expired++];
      const key = treeKey(other);
      const active = remove(groups.get(key), other);
      if (active) groups.set(key, active);
      else groups.delete(key);
    }
    for (const [group, active] of groups) {
      if (crossGroupsOnly && group === item.group) continue;
      for (const other of query(
        active,
        item.lower,
        item.upper,
        ctx,
        path,
        relatedPath,
      )) {
        if (intersects(item.box, other.box)) yield [item, other];
      }
    }
    const key = treeKey(item);
    groups.set(key, insert(groups.get(key), item));
  }
}
export function segments(points, group = 0) {
  return points.slice(1).map((b, i) => ({
    a: points[i],
    b,
    group,
    ordinal: i,
    box: bounds([points[i], b]),
  }));
}
