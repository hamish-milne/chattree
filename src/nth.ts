/** The item at a position the caller knows is there (a loop's own index, a group of a pattern that always matches): said once here, so the use does not cast. */
export function nth<T>(items: ArrayLike<T | undefined>, index: number): T {
  const item = items[index];
  if (item === undefined) throw new RangeError(`there is no item ${index} (the length is ${items.length})`);
  return item;
}
