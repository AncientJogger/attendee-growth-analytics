// Shown the instant a link is clicked, while the next page's data loads.
export default function Loading() {
  const bar = "animate-pulse rounded-lg bg-[#eef1f6]";
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className={`${bar} mb-2 h-7 w-56`} />
      <div className={`${bar} mb-6 h-4 w-96 max-w-full`} />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => <div key={i} className={`${bar} h-24`} />)}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className={`${bar} h-72 lg:col-span-2`} />
        <div className={`${bar} h-72`} />
      </div>
    </div>
  );
}
