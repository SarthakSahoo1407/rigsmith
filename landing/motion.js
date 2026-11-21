// Fallback for browsers without CSS scroll-driven animations.
if (!CSS.supports('animation-timeline: view()')) {
  document.documentElement.classList.add('fb');
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { threshold: 0.2 });
  document.querySelectorAll('.reveal, .shot').forEach((el) => io.observe(el));
}
