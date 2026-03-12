import { Routes, Route, NavLink } from 'react-router-dom';
import Rankings from './pages/Rankings';
import Draft from './pages/Draft';
import Settings from './pages/Settings';

function Nav() {
  const linkClass = ({ isActive }) =>
    `px-4 py-2 text-sm font-medium ${isActive ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500 hover:text-gray-700'}`;

  return (
    <nav className="flex gap-2 border-b border-gray-200 px-4 bg-white">
      <NavLink to="/" end className={linkClass}>Rankings</NavLink>
      <NavLink to="/draft" className={linkClass}>Draft</NavLink>
      <NavLink to="/settings" className={linkClass}>Settings</NavLink>
    </nav>
  );
}

export default function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Nav />
      <main className="p-4">
        <Routes>
          <Route path="/" element={<Rankings />} />
          <Route path="/draft" element={<Draft />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
