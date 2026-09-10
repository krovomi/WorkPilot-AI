/** Follow new output unless the reader deliberately moves away from its edge. */
export function followLogViewport(container: HTMLElement, reverse = false): () => void {
 let following = true;
 let lastTop = container.scrollTop;
 let lastHeight = container.scrollHeight;
 let lastClientHeight = container.clientHeight;
 const atEdge = () => reverse ? container.scrollTop <= 2 : container.scrollHeight - container.clientHeight - container.scrollTop <= 2;
 const follow = () => {
  if (!following) return;
  container.scrollTo({ top: reverse ? 0 : container.scrollHeight, behavior: "instant" });
  lastTop = container.scrollTop;
 };
 const onScroll = () => {
  const top = container.scrollTop;
  if (atEdge() || (!reverse && top > lastTop && top >= lastHeight - lastClientHeight - 2)) following = true;
  else if (reverse ? top > lastTop : top < lastTop) following = false;
  lastTop = top;
 };
 const onWheel = (event: WheelEvent) => {
  if (reverse ? event.deltaY > 0 : event.deltaY < 0) following = false;
 };
 const onKeyDown = (event: KeyboardEvent) => {
  const away = reverse ? ["ArrowDown", "PageDown", "End"] : ["ArrowUp", "PageUp", "Home"];
  if (away.includes(event.key)) following = false;
 };
 follow();
 container.addEventListener("scroll", onScroll, { passive: true });
 container.addEventListener("wheel", onWheel, { passive: true });
 container.addEventListener("keydown", onKeyDown);
 const observer = new ResizeObserver(() => {
  // The reader can reach the old bottom just before a new batch is laid out,
  // before the browser has delivered its scroll event.
  if (!following && container.scrollTop !== lastTop && (reverse
   ? container.scrollTop <= 2
   : container.scrollTop >= lastHeight - lastClientHeight - 2)) following = true;
  lastHeight = container.scrollHeight;
  lastClientHeight = container.clientHeight;
  follow();
 });
 observer.observe(container);
 for (const child of container.children) observer.observe(child);
 return () => {
  observer.disconnect();
  container.removeEventListener("scroll", onScroll);
  container.removeEventListener("wheel", onWheel);
  container.removeEventListener("keydown", onKeyDown);
 };
}
