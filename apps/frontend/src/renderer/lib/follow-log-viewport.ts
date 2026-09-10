/** Keep the viewport pinned after deferred rendering and content resizes. */
export function followLogViewport(container: HTMLElement, reverse = false): () => void {
 const follow = () => container.scrollTo({ top: reverse ? 0 : container.scrollHeight, behavior: "instant" });
 follow();
 const observer = new ResizeObserver(follow);
 observer.observe(container);
 // Observe the content, not just the fixed-height viewport: new log lines
 // change scrollHeight without changing the viewport's border box.
 for (const child of container.children) observer.observe(child);
 return () => observer.disconnect();
}
