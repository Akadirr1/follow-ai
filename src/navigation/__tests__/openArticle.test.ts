import {
  articleHref,
  DOUBLE_PUSH_WINDOW_MS,
  openArticle,
  resetNavigationGuard,
} from '../openArticle';

/**
 * rev-001 N1: two quick taps used to push the same detail route twice, so one
 * Back left the user still on the article. One tap must produce one push.
 */

const fakeRouter = () => {
  const pushes: string[] = [];
  return { pushes, router: { push: (href: string) => pushes.push(href) } as never };
};

describe('openArticle', () => {
  beforeEach(() => resetNavigationGuard());

  it('pushes the article route once', () => {
    const { pushes, router } = fakeRouter();
    expect(openArticle(router, 'oa')).toBe(true);
    expect(pushes).toEqual(['/article/oa']);
    expect(articleHref('oa')).toBe('/article/oa');
  });

  it('swallows a second tap on the same article inside the window', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { pushes, router } = fakeRouter();
      let clock = 1_000;
      const now = () => clock;

      expect(openArticle(router, 'oa', { now })).toBe(true);
      clock += 80; // a fast double tap
      expect(openArticle(router, 'oa', { now })).toBe(false);

      // One push, so one Back returns to the origin.
      expect(pushes).toEqual(['/article/oa']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('duplicate push'));
    } finally {
      warn.mockRestore();
    }
  });

  it('does not run the side effect for the swallowed tap', () => {
    const { router } = fakeRouter();
    let clock = 0;
    const now = () => clock;
    const marks: string[] = [];

    openArticle(router, 'oa', { now, onOpen: () => marks.push('read') });
    clock += 50;
    openArticle(router, 'oa', { now, onOpen: () => marks.push('read') });

    expect(marks).toEqual(['read']);
  });

  it('allows the same article again once the window has passed', () => {
    const { pushes, router } = fakeRouter();
    let clock = 0;
    const now = () => clock;

    openArticle(router, 'oa', { now });
    clock += DOUBLE_PUSH_WINDOW_MS + 1;
    openArticle(router, 'oa', { now });

    expect(pushes).toEqual(['/article/oa', '/article/oa']);
  });

  it('never blocks a different article', () => {
    const { pushes, router } = fakeRouter();
    let clock = 0;
    const now = () => clock;

    openArticle(router, 'oa', { now });
    clock += 10;
    openArticle(router, 'gd', { now });

    expect(pushes).toEqual(['/article/oa', '/article/gd']);
  });

  it('warns and does nothing without an id', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { pushes, router } = fakeRouter();
      expect(openArticle(router, '   ')).toBe(false);
      expect(pushes).toEqual([]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
