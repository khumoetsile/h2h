import { Routes } from '@angular/router';
import { adminGuard, authGuard, guestGuard, playerGuard } from './core/guards';
import { Shell } from './layout/shell';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  { path: 'login', canActivate: [guestGuard], title: 'Sign in', loadComponent: () => import('./features/auth/login').then((m) => m.LoginPage) },
  { path: 'register', canActivate: [guestGuard], title: 'Create account', loadComponent: () => import('./features/auth/register').then((m) => m.RegisterPage) },
  // Gameplay and its result are standalone, full-screen routes — no header,
  // no bottom nav, no balance shown, so the player can focus on the game.
  { path: 'match/:code/play', canActivate: [authGuard, playerGuard], title: 'Playing', loadComponent: () => import('./features/match/match-play').then((m) => m.MatchPlayPage) },
  { path: 'match/:code/result', canActivate: [authGuard, playerGuard], title: 'Result', loadComponent: () => import('./features/match/match-result').then((m) => m.MatchResultPage) },
  {
    path: '',
    component: Shell,
    canActivate: [authGuard],
    children: [
      { path: 'dashboard', canActivate: [playerGuard], title: 'Home', loadComponent: () => import('./features/dashboard/dashboard').then((m) => m.DashboardPage) },
      { path: 'games', canActivate: [playerGuard], title: 'Games', loadComponent: () => import('./features/games/games-list').then((m) => m.GamesPage) },
      { path: 'games/:slug', canActivate: [playerGuard], title: 'Play', loadComponent: () => import('./features/games/game-detail').then((m) => m.GameDetailPage) },
      { path: 'football', canActivate: [playerGuard], title: 'Football', loadComponent: () => import('./features/football/football-list').then((m) => m.FootballListPage) },
      { path: 'football/:fixtureId', canActivate: [playerGuard], title: 'Fixture', loadComponent: () => import('./features/football/football-fixture').then((m) => m.FootballFixturePage) },
      { path: 'match/:code', canActivate: [playerGuard], title: 'Match', loadComponent: () => import('./features/match/match-lobby').then((m) => m.MatchLobbyPage) },
      { path: 'matches', canActivate: [playerGuard], title: 'My matches', loadComponent: () => import('./features/matches/match-history').then((m) => m.MatchHistoryPage) },
      { path: 'matches/:code', title: 'Match details', loadComponent: () => import('./features/matches/match-detail').then((m) => m.MatchDetailPage) },
      { path: 'challenges', canActivate: [playerGuard], title: 'Challenges', loadComponent: () => import('./features/challenges/challenges').then((m) => m.ChallengesPage) },
      { path: 'challenges/new', canActivate: [playerGuard], title: 'New challenge', loadComponent: () => import('./features/challenges/challenge-new').then((m) => m.ChallengeNewPage) },
      { path: 'leaderboard', title: 'Leaderboard', loadComponent: () => import('./features/leaderboard/leaderboard').then((m) => m.LeaderboardPage) },
      { path: 'wallet', canActivate: [playerGuard], title: 'Demo wallet', loadComponent: () => import('./features/wallet/wallet').then((m) => m.WalletPage) },
      { path: 'wallet/deposit', canActivate: [playerGuard], title: 'Add demo funds', loadComponent: () => import('./features/wallet/deposit').then((m) => m.DepositPage) },
      { path: 'wallet/withdraw', canActivate: [playerGuard], title: 'Demo withdrawal', loadComponent: () => import('./features/wallet/withdraw').then((m) => m.WithdrawPage) },
      { path: 'wallet/transactions', canActivate: [playerGuard], title: 'Transactions', loadComponent: () => import('./features/wallet/transactions').then((m) => m.TransactionsPage) },
      { path: 'profile', title: 'Profile', loadComponent: () => import('./features/profile/profile').then((m) => m.ProfilePage) },
      { path: 'players/:username', title: 'Player', loadComponent: () => import('./features/profile/player-profile').then((m) => m.PlayerProfilePage) },
      { path: 'notifications', title: 'Notifications', loadComponent: () => import('./features/notifications/notifications').then((m) => m.NotificationsPage) },
      {
        path: 'admin',
        canActivate: [adminGuard],
        children: [
          { path: '', title: 'Admin', loadComponent: () => import('./features/admin/admin-dashboard').then((m) => m.AdminDashboardPage) },
          { path: 'users', title: 'Users', loadComponent: () => import('./features/admin/admin-users').then((m) => m.AdminUsersPage) },
          { path: 'users/:id', title: 'User', loadComponent: () => import('./features/admin/admin-user-detail').then((m) => m.AdminUserDetailPage) },
          { path: 'transactions', title: 'Transactions', loadComponent: () => import('./features/admin/admin-transactions').then((m) => m.AdminTransactionsPage) },
          { path: 'matches', title: 'Matches', loadComponent: () => import('./features/admin/admin-matches').then((m) => m.AdminMatchesPage) },
          { path: 'challenges', title: 'Challenges', loadComponent: () => import('./features/admin/admin-challenges').then((m) => m.AdminChallengesPage) },
          { path: 'games', title: 'Games', loadComponent: () => import('./features/admin/admin-games').then((m) => m.AdminGamesPage) },
          { path: 'settings', title: 'Settings', loadComponent: () => import('./features/admin/admin-settings').then((m) => m.AdminSettingsPage) },
        ],
      },
    ],
  },
  { path: '**', title: 'Not found', loadComponent: () => import('./features/not-found').then((m) => m.NotFoundPage) },
];
