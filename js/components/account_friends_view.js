import { renderAccountSubView } from './account_subview.js';
import {
  hydrateAccountFriendsSection,
  renderAccountFriendsSectionMarkup,
} from './account_friends_section.js';

export function renderFriendsView(content, {
  onBack,
  sectionDeps,
} = {}) {
  renderAccountSubView(content, {
    view: 'friends',
    title: 'Friends',
    subtitle: 'Control the header shortcut and review active sharing links.',
    bodyHtml: renderAccountFriendsSectionMarkup(),
    onBack,
    onAfterRender: panel => hydrateAccountFriendsSection(panel, sectionDeps),
  });
}
