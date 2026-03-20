import { Routes, Route, NavLink } from 'react-router-dom';
import Rankings from './pages/Rankings';
import Draft from './pages/Draft';
import Settings from './pages/Settings';
import FreshnessBar from './components/FreshnessBar';

function Nav() {
  const linkClass = ({ isActive }) =>
    `px-4 py-3 text-sm font-medium transition-colors ${isActive ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500 hover:text-gray-700 border-b-2 border-transparent'}`;

  return (
    <nav className="flex items-center gap-1 border-b border-gray-200 px-6 bg-white shadow-sm">
      <NavLink to="/" end className={linkClass}>Rankings</NavLink>
      <NavLink to="/draft" className={linkClass}>Draft</NavLink>
      <NavLink to="/settings" className={linkClass}>Settings</NavLink>
      <div className="ml-auto py-3">
        <FreshnessBar />
      </div>
    </nav>
  );
}

export default function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Nav />
      <main className="px-6 py-4">
        <Routes>
          <Route path="/" element={<Rankings />} />
          <Route path="/draft" element={<Draft />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
