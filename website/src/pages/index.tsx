import React from 'react';
import {Redirect} from '@docusaurus/router';
import useBaseUrl from '@docusaurus/useBaseUrl';

export default function Home(): React.JSX.Element {
  return <Redirect to={useBaseUrl('/getting-started/quickstart/')} />;
}
